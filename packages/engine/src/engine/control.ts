import type { TurnInputMessage, TurnOutcomeStatus } from '@elmino/loop'
import type { RuntimeStore, ThreadMessage, ThreadPart } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import {
  applyRuntimeToolOutputDelta,
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
} from '@elmino/thread'
/** -------------------- 类型 -------------------- */
/** 当前进程内的单次 Turn 控制记录 */
export interface TurnControl {
  /** 获得执行权的固定 Agent */
  agentId: string
  /** 获得执行权时绑定的事实存储 */
  store: RuntimeStore
  /** Turn ID */
  turnId: string
  /** 取消控制器 */
  controller: AbortController
  /** Turn 已经开始固定终态，不再接受新的控制请求 */
  settling: boolean
  /** Step 已确认退出，不再接纳引导 */
  steeringClosed: boolean
  /** 按接纳顺序等待持久化的引导消息 */
  steering: Promise<TurnInputMessage | undefined>[]
}

/** 引导目标不再是可接纳的活跃 Turn */
export class TurnSteerRejectedError extends Error {}

/** 运行中 assistant reasoning、文本或工具输出投影 */
interface ActiveTurnContentPart {
  /** 消息片段类型 */
  type: 'reasoning' | 'text' | 'tool'
  /** 当前 Turn ID */
  turnId?: string
  /** 当前 Thread ID */
  threadId: string
  /** 当前 Message ID */
  messageId: string
  /** 当前 Part ID */
  partId: string
  /** 尚未完整落库的最新正文 */
  content: string
  /** 最近更新时间 */
  updatedAt: string
}

/** 子任务状态变更监听器 */
interface SubagentStatusWaiter {
  /** 监听的子线程集合 */
  threadIds: ReadonlySet<string>
  /** 完成当前等待 */
  resolve: () => void
  /** 超时计时器 */
  timer?: ReturnType<typeof setTimeout>
  /** 外部取消监听器 */
  abort?: () => void
}

/** 已提交 Turn 的完整异步执行记录 */
interface TrackedTurn {
  /** 所属线程 ID */
  threadId: string
  /** 包含提交失败结算在内的完整任务 */
  settled: Promise<void>
}

/** Engine 入口在异步准备期间持有的线程操作预留 */
export interface TurnReservation {
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId: string
}

/** -------------------- 核心类 -------------------- */
/**
 * 管理进程内 Turn 控制、流式正文投影和子任务状态订阅
 */
export class TurnControlRegistry {
  /** 按线程记录当前活跃 Turn */
  private readonly _turns = new Map<string, TurnControl>()
  /** 按 part 保存当前活跃 Turn 的完整文本或工具输出 */
  private readonly _contentParts = new Map<string, ActiveTurnContentPart>()
  /** 等待任意目标子任务状态变化的监听器 */
  private readonly _statusWaiters = new Set<SubagentStatusWaiter>()
  /** 按 Turn 记录尚未完全退出的异步提交任务 */
  private readonly _tasks = new Map<string, TrackedTurn>()
  /** 等待准确 Turn 释放进程控制器的监听器 */
  private readonly _completionWaiters = new Map<string, Set<() => void>>()

  /** 已进入删除边界且禁止继续接收运行的线程 */
  private readonly _closingThreads = new Set<string>()

  /** Engine 入口异步准备期间持有的线程操作预留 */
  private readonly _reservations = new Map<string, TurnReservation>()

  /** 等待线程入口准备阶段退出的监听器 */
  private readonly _reservationWaiters = new Map<string, Set<() => void>>()

  /** Engine 已经停止接收新的 Turn */
  private _closed = false

  /** Engine 关闭与全部已接收 Turn 退出的共享任务 */
  private _closing?: Promise<void>

  /**
   * 创建进程内运行控制注册表
   */
  public static create() {
    return new TurnControlRegistry()
  }

  /**
   * 运行控制注册表通过静态工厂创建
   */
  private constructor() {}

  /** -------------------- 核心方法 -------------------- */
  /**
   * 在任何异步准备开始前预留线程运行入口
   */
  public reserve(threadId: string, turnId: string) {
    const reservation = { threadId, turnId }

    this._assertThreadOpen(reservation)

    const tracked = [...this._tasks].find(([, task]) => task.threadId === threadId)

    if (tracked)
      throw new Error(`线程 ${threadId} 已在运行: ${tracked[0]}`)

    const activeTurnId = this._turns.get(threadId)?.turnId
      ?? this._reservations.get(threadId)?.turnId

    if (activeTurnId)
      throw new Error(`线程 ${threadId} 已在运行: ${activeTurnId}`)

    this._reservations.set(threadId, reservation)

    return reservation
  }

  /**
   * 释放已经完成 start、schedule 和 track 装配的入口预留
   */
  public release(reservation: TurnReservation) {
    if (this._reservations.get(reservation.threadId) !== reservation)
      return

    this._reservations.delete(reservation.threadId)

    for (const resolve of this._reservationWaiters.get(reservation.threadId) ?? [])
      resolve()

    this._reservationWaiters.delete(reservation.threadId)
  }

  /**
   * 建立持久关闭栅栏并等待已经进入 Engine 的准备阶段完成装配
   */
  public beginThreadClose(threadId: string) {
    this._closingThreads.add(threadId)

    if (!this._reservations.has(threadId))
      return Promise.resolve()

    return new Promise<void>((resolve) => {
      const waiters = this._reservationWaiters.get(threadId) ?? new Set()

      waiters.add(resolve)
      this._reservationWaiters.set(threadId, waiters)
    })
  }

  /**
   * 注册一次不可变 Turn
   */
  public start(turn: TurnReservation, owner: Pick<TurnControl, 'agentId' | 'store'>) {
    this._assertThreadOpen(turn)
    const { turnId, threadId } = turn

    const current = this._turns.get(threadId)

    if (current)
      throw new Error(`线程 ${threadId} 已在运行: ${current.turnId}`)

    const control: TurnControl = {
      ...owner,
      turnId,
      controller: new AbortController(),
      settling: false,
      steeringClosed: false,
      steering: [],
    }

    this._turns.set(threadId, control)

    // 关闭开始前已经被接收的排队子任务仍需进入统一结算，但不得继续调用 Provider
    if (this._closed)
      control.controller.abort('AgentEngine 正在关闭')

    return control
  }

  /**
   * 读取线程当前运行控制
   */
  public get(threadId: string) {
    return this._turns.get(threadId)
  }

  /** 是否已接纳该 Turn，包括准备、排队、运行和最终协程退出阶段 */
  public owns(threadId: string, turnId: string) {
    return this._turns.get(threadId)?.turnId === turnId
      || this._tasks.get(turnId)?.threadId === threadId
      || this._reservations.get(threadId)?.turnId === turnId
  }

  /**
   * 同步取得目标 Turn 的引导接纳权，再执行消息持久化
   */
  public steer(
    threadId: string,
    turnId: string,
    persist: () => Promise<TurnInputMessage>,
  ) {
    const control = this._turns.get(threadId)

    if (
      control?.turnId !== turnId
      || control.settling
      || control.steeringClosed
      || control.controller.signal.aborted
    ) {
      throw new TurnSteerRejectedError('目标运行已结束或正在结算')
    }

    const result = Promise.resolve().then(persist)
    control.steering.push(result.catch(() => undefined))

    return result
  }

  /**
   * 在 Step 安全边界消费引导，仅在真正退出时关闭入口
   */
  public async afterStep(control: TurnControl, status?: TurnOutcomeStatus) {
    const messages: TurnInputMessage[] = []

    // 失败或中断只能结算，不能由已接纳的引导重新启动采样
    if (status && status !== 'completed') {
      control.steeringClosed = true
      return messages
    }

    while (true) {
      const pending = control.steering.splice(0)

      if (pending.length === 0) {
        if (status === 'completed' && messages.length === 0)
          control.steeringClosed = true

        return messages
      }

      const settled = (await Promise.all(pending))
        .filter((message): message is TurnInputMessage => Boolean(message))

      messages.push(...settled)
      // 持久化等待期间仍可接纳新消息；必须在下一次采样前一起消费
    }
  }

  /**
   * 中断线程当前运行
   */
  public interrupt(
    threadId: string,
    reason = 'interrupted',
    turnId?: string,
  ) {
    const control = this._turns.get(threadId)

    if (turnId && control?.turnId !== turnId)
      return

    if (!control || control.settling)
      return

    control.controller.abort(reason)

    return control
  }

  /**
   * 关闭控制请求入口并固定本次 Turn 的唯一结算权
   */
  public async beginSettlement(control: TurnControl) {
    if (control.settling)
      return false

    control.settling = true
    control.steeringClosed = true
    const pending = control.steering.splice(0)

    await Promise.all(pending)

    return true
  }

  /**
   * 移除已经结束的准确 Turn
   */
  public complete(threadId: string, turnId: string) {
    if (this._turns.get(threadId)?.turnId === turnId) {
      this._turns.delete(threadId)
      this._deleteTurnContent(threadId, turnId)
    }

    const key = this._turnKey(threadId, turnId)

    for (const resolve of this._completionWaiters.get(key) ?? [])
      resolve()

    this._completionWaiters.delete(key)
  }

  /**
   * 跟踪包含调度和失败结算在内的完整异步 Turn
   */
  public track<T>(
    reservation: TurnReservation,
    execute: () => Promise<T>,
  ) {
    this._assertThreadOpen(reservation)
    const { turnId, threadId } = reservation

    const current = this._tasks.get(turnId)

    if (current)
      throw new Error(`线程 ${threadId} 已在运行: ${turnId}`)

    const completion = Promise.withResolvers<void>()
    const settled = completion.promise
    const tracked = { threadId, settled }

    this._tasks.set(turnId, tracked)
    let task: Promise<T>

    try {
      task = execute()
    }
    catch (error) {
      this._tasks.delete(turnId)
      completion.resolve()
      throw error
    }
    task.then(() => completion.resolve(), () => completion.resolve())
    settled.then(
      () => {
        if (this._tasks.get(turnId) === tracked)
          this._tasks.delete(turnId)
      },
      () => undefined,
    )

    return task
  }

  /**
   * 停止接收新 Turn，中断活跃 Turn，并等待全部准备、调度和结算协程退出
   */
  public close() {
    if (this._closing)
      return this._closing

    this._closed = true

    this._closing = (async () => {
      /** 中断当前已经取得执行控制权的 Turn */
      const abortActiveTurns = () => {
        for (const control of this._turns.values()) {
          if (!control.settling)
            control.controller.abort('AgentEngine 正在关闭')
        }
      }

      abortActiveTurns()

      // 关闭栅栏建立前取得入口预留的 Turn 可以完成装配，之后都会被中断并进入稳定结算
      const preparingThreads = [...this._reservations.keys()]

      await Promise.all(preparingThreads.map((threadId) => {
        if (!this._reservations.has(threadId))
          return Promise.resolve()

        return new Promise<void>((resolve) => {
          const waiters = this._reservationWaiters.get(threadId) ?? new Set()

          waiters.add(resolve)
          this._reservationWaiters.set(threadId, waiters)
        })
      }))
      abortActiveTurns()

      // 任务集合在全部入口预留退出后不会再增长；循环同时覆盖调度器刚释放的排队子任务
      while (this._tasks.size > 0) {
        await Promise.all(
          [...this._tasks.values()].map(task => task.settled),
        )
      }

      for (const waiter of [...this._statusWaiters])
        waiter.resolve()
    })()

    return this._closing
  }

  /**
   * 等待准确 Turn 的执行协程和异步结算全部退出
   */
  public async waitForCompletion(threadId: string, turnId: string) {
    const control = this._turns.get(threadId)
    const controlSettled = control?.turnId === turnId
      ? new Promise<void>((resolve) => {
          const key = this._turnKey(threadId, turnId)
          const waiters = this._completionWaiters.get(key) ?? new Set()

          waiters.add(resolve)
          this._completionWaiters.set(key, waiters)
        })
      : Promise.resolve()
    const task = this._tasks.get(turnId)
    const taskSettled = task?.threadId === threadId
      ? task.settled
      : Promise.resolve()

    await Promise.all([controlSettled, taskSettled])
  }

  /**
   * 唤醒监听当前子线程的子任务等待调用
   */
  public notifySubagent(threadId: string) {
    for (const waiter of this._statusWaiters) {
      if (waiter.threadIds.has(threadId))
        waiter.resolve()
    }
  }

  /**
   * 等待任一目标子任务状态变化或超时
   */
  public waitForSubagentChange(
    threadIds: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      return Promise.reject(signal.reason)

    return new Promise<boolean>((resolve, reject) => {
      let waiter: SubagentStatusWaiter

      /** 完成后必须同步移除计时器和取消监听，避免跨轮唤醒 */
      const settle = () => {
        if (waiter.timer !== undefined)
          clearTimeout(waiter.timer)
        this._statusWaiters.delete(waiter)
        if (waiter.abort)
          signal?.removeEventListener('abort', waiter.abort)
      }
      /** 完成当前状态等待 */
      const complete = (timedOut: boolean) => {
        settle()
        resolve(timedOut)
      }
      /** 中止当前状态等待 */
      const abort = () => {
        settle()
        reject(signal?.reason)
      }

      waiter = {
        threadIds: new Set(threadIds),
        resolve: () => complete(false),
        timer: timeoutMs === undefined
          ? undefined
          : setTimeout(complete, timeoutMs, true),
        abort: signal ? abort : undefined,
      }
      this._statusWaiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * 从运行事件维护尚未完整落库的 reasoning、文本和工具输出投影
   */
  public applyEvent(event: RuntimeEvent) {
    if (event.type === 'message.part.updated')
      this._applyPartUpdated(event)
    if (event.type === 'message.part.delta')
      this._applyPartDelta(event)
    if (event.type === 'message.part.removed')
      this._deleteEventPart(event)
  }

  /**
   * 用当前活跃 Turn 内容覆盖数据库中稍旧的 running part
   */
  public mergeThreadMessages(threadId: string, messages: ThreadMessage[]) {
    const liveParts = Array.from(this._contentParts.values())
      .filter(part => part.threadId === threadId)

    if (liveParts.length === 0)
      return messages

    const livePartByKey = new Map(liveParts.map(part => [
      this._partKey(part.threadId, part.messageId, part.partId),
      part,
    ]))
    let changed = false
    const nextMessages = messages.map((message) => {
      let messageChanged = false
      const parts = message.parts.map((part) => {
        if (
          part.status !== 'running'
          || (part.type !== 'reasoning'
            && part.type !== 'text'
            && part.type !== 'tool')
        ) {
          return part
        }

        const livePart = livePartByKey.get(this._partKey(threadId, message.id, part.id))

        if (
          !livePart
          || livePart.turnId !== part.turnId
        ) {
          return part
        }

        const content = part.type === 'tool'
          ? part.output ?? ''
          : part.text

        if (livePart.content === content)
          return part

        changed = true
        messageChanged = true

        return part.type === 'tool'
          ? {
            ...part,
            output: livePart.content,
            updatedAt: livePart.updatedAt,
          } satisfies Extract<ThreadPart, { type: 'tool' }>
          : {
            ...part,
            text: livePart.content,
            updatedAt: livePart.updatedAt,
          } satisfies Extract<ThreadPart, { type: 'reasoning' | 'text' }>
      })

      return messageChanged
        ? {
            ...message,
            parts,
            updatedAt: parts.reduce((latest, part) => {
              return part.updatedAt.localeCompare(latest) > 0
                ? part.updatedAt
                : latest
            }, message.updatedAt),
          }
        : message
    })

    return changed ? nextMessages : messages
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 拒绝删除开始后的新运行，只允许删除前已经取得的入口预留完成装配
   */
  private _assertThreadOpen(turn: TurnReservation) {
    const reserved = this._reservations.get(turn.threadId) === turn

    if (this._closed && !reserved && !this._tasks.has(turn.turnId))
      throw new Error('AgentEngine 正在关闭')

    if (this._closingThreads.has(turn.threadId) && !reserved)
      throw new Error(`线程 ${turn.threadId} 正在删除`)
  }

  /**
   * 从完整 part 更新当前 reasoning、文本或工具输出投影
   */
  private _applyPartUpdated(event: RuntimeEvent) {
    const part = readRuntimeEventPartPayload(event)

    if (
      !part || (
        part.type !== 'reasoning'
        && part.type !== 'text'
        && part.type !== 'tool'
      )
    ) {
      return
    }

    const key = this._partKey(part.threadId, part.messageId, part.id)

    if (part.status !== 'running') {
      this._contentParts.delete(key)
      return
    }

    this._contentParts.set(key, {
      type: part.type,
      turnId: part.turnId,
      threadId: part.threadId,
      messageId: part.messageId,
      partId: part.id,
      content: part.type === 'tool' ? part.output ?? '' : part.text,
      updatedAt: part.updatedAt,
    })
  }

  /**
   * 把 reasoning、文本或工具输出增量合入当前完整内容投影
   */
  private _applyPartDelta(event: RuntimeEvent) {
    const payload = readRuntimeEventPartDeltaPayload(event)
    const { messageId, partId } = event
    if (!payload || !messageId || !partId)
      return

    const key = this._partKey(event.threadId, messageId, partId)
    const current = this._contentParts.get(key)
    const type = current?.type ?? ('output' in payload.delta ? 'tool' : 'text')

    if (current && (current.type === 'tool') !== ('output' in payload.delta))
      return

    const content = 'output' in payload.delta
      ? applyRuntimeToolOutputDelta(current?.content ?? '', payload.delta)
      : `${current?.content ?? ''}${payload.delta.text}`

    if (content === undefined)
      return

    this._contentParts.set(key, {
      type,
      turnId: current?.turnId ?? event.turnId,
      threadId: event.threadId,
      messageId,
      partId,
      content,
      updatedAt: event.createdAt,
    })
  }

  /**
   * 从 part 删除事件清理当前正文投影
   */
  private _deleteEventPart(event: RuntimeEvent) {
    const { messageId, partId } = event

    if (messageId && partId)
      this._contentParts.delete(this._partKey(event.threadId, messageId, partId))
  }

  /**
   * 清理指定 Turn 的所有运行中正文
   */
  private _deleteTurnContent(threadId: string, turnId: string) {
    for (const [key, part] of this._contentParts.entries()) {
      if (part.threadId === threadId && part.turnId === turnId)
        this._contentParts.delete(key)
    }
  }

  /**
   * 生成运行中正文索引键
   */
  private _partKey(threadId: string, messageId: string, partId: string) {
    return `${threadId}:${messageId}:${partId}`
  }

  /**
   * 生成准确 Turn 的进程控制索引键
   */
  private _turnKey(threadId: string, turnId: string) {
    return `${threadId}:${turnId}`
  }
}
