import type { Agent } from '@elmino/agent'
import type { Message } from '@elmino/llm'
import type { TurnRuntimeEventHandler, TurnServices } from '@elmino/loop'
import type { Runtime, ThreadLocation } from '@elmino/runtime'
import type { Promisable } from '@elmino/shared'
import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import type { PreparedTurn, ResolvedTurnRequest, TurnExecution, TurnHandle, TurnRequest } from '../turn/types'
import type { TurnReservation } from './control'
import type { AgentEngineOptions, RuntimeFactoryContext, WorkspaceAccessAcquirer } from './options'
import { deepEqual, objectValues, throwSettledErrors } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread'
import { auxQueueHostService, provideHostService, subagentHostService } from '@elmino/tool'
import { JobQueue } from '../job/index'
import { SubagentCoordinator } from '../subagent/coordinator'
import { getBuiltinSubagentRoles } from '../subagent/roles'
import { TurnControlRegistry } from './control'
import { TurnExecutor } from './execution'
/** -------------------- 类型 -------------------- */
/** 单个固定 Agent 的执行与子任务能力 */
interface EngineEntry {
  /** Runtime 工厂 */
  createRuntime: (context: RuntimeFactoryContext) => Runtime
  /** 单 Turn 执行边界 */
  executor: TurnExecutor
  /** 当前 Agent 的进程内 Job 队列 */
  queues: Record<'turn' | 'aux', JobQueue>
  /** 子智能体协调边界 */
  subagents: SubagentCoordinator
  /** 当前 Agent 的宿主事件出口 */
  onRuntimeEvent?: TurnRuntimeEventHandler
}

/** queued Turn 失败结算只需要的稳定事实 */
interface SettleQueuedFailureInput {
  /** 当前 Turn 冻结的 Agent ID */
  agentId: string
  /** 线程 ID */
  threadId: string
  /** Turn ID */
  turnId: string
  /** 当前项目事实存储 */
  store: RuntimeStore
  /** 失败原因 */
  error: unknown
  /** 请求调用方的运行事件出口 */
  onRuntimeEvent?: TurnRuntimeEventHandler
}

/** -------------------- 核心类 -------------------- */
/**
 * 为 HTTP、子智能体和未来调度器提供统一 Agent 执行入口
 */
export class AgentEngine {
  /** 当前进程运行控制器 */
  private readonly _turns = TurnControlRegistry.create()

  /** 按固定 Agent ID 索引的执行能力 */
  private readonly _entries = new Map<string, EngineEntry>()

  /** 按线程复用的 Runtime */
  private readonly _runtimes = new Map<string, {
    /** 创建线程 Runtime 的固定 Agent */
    agentId: string
    /** 当前线程所拥有的执行资源 */
    runtime: Runtime
  }>()

  /** Engine 关闭任务 */
  private _closing?: Promise<void>

  /** 宿主提供的项目 Turn 访问凭证入口 */
  private readonly _acquireWorkspace?: WorkspaceAccessAcquirer

  /**
   * 创建 Agent 执行引擎
   */
  public static create(agents: Record<string, Agent>, options: AgentEngineOptions = {}) {
    return new AgentEngine(agents, options)
  }

  /**
   * 组合单 Turn 执行和子智能体协调能力
   */
  private constructor(agents: Record<string, Agent>, options: AgentEngineOptions) {
    // 宿主装配能力在构造时捕获，后续各 Agent 共享同一套资源边界
    const {
      acquireWorkspace,
      createRuntime: runtimeFactory,
      onRuntimeEvent: emitRuntimeEvent,
      subagentRoles = getBuiltinSubagentRoles,
      restoreModel,
    } = options
    // 执行器和子任务协调器共用这份进程控制注册表
    const turns = this._turns
    /** 将子智能体请求提交回当前 Engine */
    const submit = this.submit.bind(this)

    this._acquireWorkspace = acquireWorkspace

    // 为每个固定 Agent 分别装配队列、执行器和子任务协调器
    for (const agent of objectValues(agents)) {
      // Turn 与辅助任务分别限流，避免辅助工作占用子任务执行槽
      const queues = {
        turn: JobQueue.create(4),
        aux: JobQueue.create(4),
      }
      // 子智能体调度只借用 Turn 队列，不操作辅助队列
      const turnQueue = queues.turn
      // 当前 Agent 的单轮执行、事务准备与结算归同一个执行器
      const executor = TurnExecutor.create(agent, turns)
      /** 将宿主 Runtime 工厂绑定到当前 Agent */
      const createRuntime = (context: RuntimeFactoryContext) => runtimeFactory
        ? runtimeFactory(agent, context)
        : agent.runtime.create({ agentId: agent.id, ...context })
      // 事件出口预先绑定 Agent 身份，避免跨定义混淆事件归属
      const onRuntimeEvent = emitRuntimeEvent?.bind(undefined, agent.id)

      // 协调器复用本 Agent 的队列、执行器与控制注册表
      const subagents = SubagentCoordinator.create({
        agent,
        turnQueue,
        turns,
        executor,
        subagentRoles,
        restoreModel,
        onRuntimeEvent,
        submit,
      })

      this._entries.set(agent.id, {
        createRuntime,
        executor,
        queues,
        subagents,
        onRuntimeEvent,
      })
    }
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建前台 Turn，分别暴露接纳确认和执行完成
   */
  public run(options: TurnRequest, store: RuntimeStore) {
    return this._runForeground(this._freezeRequest(options), 'start', store)
  }

  /**
   * 提交已经持久化的后台 Turn，供子智能体和未来定时调度统一调用
   */
  public async submit(
    options: TurnRequest,
    store: RuntimeStore,
  ): Promise<TurnHandle> {
    options = this._freezeRequest(options)
    // 工作区访问凭证覆盖准备和后台执行，结束后才允许宿主释放工作区
    const permit = this._acquireWorkspace?.(
      options.agentId,
      options.location.workspaceId,
    )
    // 入口预留在异步准备前取得，防止同线程并发提交
    let reservation: TurnReservation

    try {
      reservation = this._turns.reserve(options.threadId, options.turnId)
    }
    catch (error) {
      permit?.release()
      throw error
    }
    // 准备失败由当前入口释放凭证，成功移交后由后台任务释放
    let releaseOnReturn = true
    /** 后台 Turn 结束后释放项目占用 */
    const releaseWorkspace = () => permit?.release()

    try {
      // 持久身份与执行资源准备完成后才能进入队列
      const prepared = await this._prepare(
        options,
        'submit',
        reservation,
        store,
      )
      // 调度与返回句柄均使用准备阶段冻结的身份和状态
      const { agentSnapshot, signal, threadId, turnId, turnStatus } = prepared
      // 按已冻结的 Agent 身份选择队列，不重新读取调用方配置
      const { queues } = this._entry(agentSnapshot.id)
      /** 执行已经完成准备的 Turn */
      const execute = () => this._execute(prepared)
      if (turnStatus === 'running')
        throw new Error(`Turn 正在由其他执行器处理: ${turnId}`)

      // 跟踪完整排队、执行和失败结算，线程关闭会等待这段生命周期
      const task = this._turns.track(reservation, () => queues.turn
        .submit(turnId, execute, signal)
        .catch(error => this._settleSubmittedFailure(prepared, error))
        .finally(releaseWorkspace))

      releaseOnReturn = false
      task.catch((error) => {
        console.error('后台 Turn 结算失败', error)
      })
      // 返回接纳时的队列状态，模型可能尚未取得执行槽
      const status = queues.turn.status(turnId) ?? 'running'
      return { threadId, turnId, status }
    }
    finally {
      this._turns.release(reservation)

      if (releaseOnReturn)
        releaseWorkspace()
    }
  }

  /**
   * 恢复已有 interrupted Turn，分别暴露接纳确认和执行完成
   */
  public resume(options: TurnRequest, store: RuntimeStore) {
    return this._runForeground(this._freezeRequest(options), 'resume', store)
  }

  /**
   * 禁止线程接受后续运行并等待已经进入 Engine 的入口完成装配
   */
  public beginThreadClose(threadId: string) {
    return this._turns.beginThreadClose(threadId)
  }

  /**
   * 释放指定线程的 Runtime，未指定时释放全部
   */
  public async disposeRuntimes(threadIds?: readonly string[]) {
    // 只选择请求关闭的 Runtime；不指定线程时关闭全部缓存资源
    const entries = [...this._runtimes].filter(
      ([threadId]) => !threadIds || threadIds.includes(threadId),
    )
    // 逐项记录释放结果，让某个 Runtime 失败不阻止其他线程清理
    const results = await Promise.allSettled(
      entries.map(([, entry]) => entry.runtime.dispose()),
    )

    // 释放成功才移除对应缓存，失败的资源保留给后续重试
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled')
        this._runtimes.delete(entries[index]![0])
    }

    throwSettledErrors(results, '关闭 Thread Runtime 失败')
  }

  /**
   * 关闭整个 Engine，等待全部 Turn 结算并释放 Job 队列与 Thread Runtime
   */
  public close() {
    if (this._closing)
      return this._closing

    this._closing = (async () => {
      // Turn 控制面先让排队 Child 依次取得控制并以 interrupted 结算，之后队列才可关闭
      const turnResults = await Promise.allSettled([this._turns.close()])
      // 控制面退出后才关闭任务队列，避免排队取消丢失持久结算
      const jobClosings = [...this._entries.values()].flatMap(entry => [
        entry.queues.turn.close(),
        entry.queues.aux.close(),
      ])
      // 汇总控制面、队列和 Runtime 的所有清理结果后统一报告
      const results = [
        ...turnResults,
        ...await Promise.allSettled(jobClosings),
        ...await Promise.allSettled([this.disposeRuntimes()]),
      ]

      throwSettledErrors(results, '关闭 AgentEngine 资源失败', true)
    })()

    return this._closing
  }

  /**
   * 中断线程的当前 Turn
   */
  public async interrupt(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 线程 ID */
    threadId: string
    /** 用户控制请求必须命中的 Turn ID，删除等管理操作可以省略 */
    turnId?: string
    /** 当前项目事实存储 */
    store: RuntimeStore
    /** 中断原因 */
    reason?: string
  }) {
    this._entry(input.agentId)
    // 先读取进程内活跃执行，没有控制器时再检查持久子任务
    const active = this._turns.get(input.threadId)

    if (!active) {
      await this._assertThreadOwner(input)
      return this._entry(input.agentId).subagents.cancelChild({
        threadId: input.threadId,
        turnId: input.turnId,
        store: input.store,
      })
    }
    if (active.agentId !== input.agentId || active.store !== input.store)
      throw new Error('活跃 Turn 不属于当前 Agent 或存储')
    // 只向匹配的 Turn 发出取消，已经开始结算的控制器不会再接纳中断
    const control = this._turns.interrupt(
      input.threadId,
      input.reason,
      input.turnId,
    )

    if (!control) {
      // 当前目标已经冻结终态时只能等待原结算，不能误走持久子线程的取消分支
      if (active && (!input.turnId || active.turnId === input.turnId)) {
        await this._turns.waitForCompletion(input.threadId, active.turnId)
        return false
      }

      return false
    }

    await this._turns.waitForCompletion(input.threadId, control.turnId)

    return true
  }

  /**
   * 取消原待交互 Turn，不经过交互回复或重新解析模型
   */
  public cancelInteraction(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 线程 ID */
    threadId: string
    /** 原运行 ID */
    turnId: string
    /** 必须仍待处理的交互中断 */
    interruptId: string
    /** 当前项目事实存储 */
    store: RuntimeStore
    /** 用户提供的取消原因 */
    reason?: string
  }) {
    // 取消操作复用目标 Agent 的执行器与事件出口
    const entry = this._entry(input.agentId)
    // 在事务前占用线程入口，阻止审批恢复与取消同时接纳
    const reservation = this._turns.reserve(input.threadId, input.turnId)

    try {
      return this._turns.track(reservation, async () => {
        await this._assertThreadOwner(input)
        // 用户原因用于持久运行结果、待执行工具收口与终态事件
        const reason = input.reason ?? '用户取消了待处理任务'
        // 事务同时校验待处理交互并固定取消事实，失败时不发布终态
        const endedAt = await entry.executor.settleTurn({
          store: input.store,
          threadId: input.threadId,
          turnId: input.turnId,
          interruptId: input.interruptId,
          from: ['interrupted'],
          status: 'cancelled',
          threadStatus: 'interrupted',
          errorMessage: reason,
          markUnread: false,
        })

        if (!endedAt)
          return false

        try {
          await entry.subagents.interruptChildren({ parentTurnId: input.turnId, store: input.store })
        }
        catch (error) {
          // 根 Turn 已取消，子任务清理失败不能阻止发布权威终态
          console.warn('[engine] 取消派生任务失败', error)
        }
        // 取消通知使用事务确认的时间，与读取到的持久状态保持一致
        const event = createRuntimeEvent({
          type: 'turn.cancelled',
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: endedAt,
          payload: { message: reason, reason, threadStatus: 'interrupted' },
        })

        try {
          try {
            await entry.onRuntimeEvent?.(event)
          }
          finally {
            // 宿主通知失败也必须唤醒等待这个子任务的父执行
            await entry.subagents.publishSettledTurn(input)
          }
        }
        catch (error) {
          // 取消事实已落库，通知失败不能把操作报告为未提交
          console.warn('[engine] Turn 取消事件发布失败', error)
        }
        return true
      })
    }
    finally {
      this._turns.release(reservation)
    }
  }

  /**
   * 将纯文本引导提交给准确的活跃 Turn
   */
  public async steer(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 线程 ID */
    threadId: string
    /** 预期活跃 Turn ID */
    turnId: string
    /** 用户输入文本 */
    text: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    this._entry(input.agentId)
    // 活跃控制器是引导请求的所有权依据，不能只按线程 ID 写入
    const active = this._turns.get(input.threadId)

    if (active) {
      if (active.agentId !== input.agentId || active.store !== input.store)
        throw new Error('活跃 Turn 不属于当前 Agent 或存储')
    }
    else {
      await this._assertThreadOwner(input)
    }
    // Agent 身份只用于选择执行能力，其余字段属于具体引导请求
    const { agentId, ...request } = input
    // 使用归属 Agent 的执行器持久化引导和发送消息事件
    const entry = this._entry(agentId)
    // 消息已在正确 Turn 内持久化后，才把其身份返回给调用方
    const message = await entry.executor.steer({
      ...request,
      onRuntimeEvent: entry.onRuntimeEvent,
    })

    return {
      turnId: input.turnId,
      messageId: message.transcript!.id,
    }
  }

  /**
   * 用当前进程的流式文本补齐持久化消息投影
   */
  public mergeThreadMessages(threadId: string, messages: ThreadMessage[]) {
    return this._turns.mergeThreadMessages(threadId, messages)
  }

  /**
   * 校准项目中进程丢失的 Turn，并重新提交可恢复的 queued 子线程
   */
  public recoverWorkspace(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 当前项目事实存储 */
    store: RuntimeStore
    /** 在真正恢复 queued 子线程前解析其完整执行位置 */
    threadLocation: (
      thread: { id: string, dir: string },
    ) => Promisable<ThreadLocation>
    /** 是否重新提交可恢复的 queued 子线程 */
    resumeQueuedChildren?: boolean
  }) {
    // 恢复委托给当前 Agent 的协调器，存储和位置解析随请求传递
    const { agentId, ...request } = input

    return this._entry(agentId).subagents.recoverWorkspace(request)
  }

  /**
   * 读取父线程直接派生的通用子线程状态
   */
  public async listChildren(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 父线程 ID */
    parentThreadId: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    await this._assertThreadOwner({ ...input, threadId: input.parentThreadId })
    // 父线程归属验证后，只把子任务查询参数传入协调器
    const { agentId, ...request } = input

    return this._entry(agentId).subagents.listChildren(request)
  }

  /**
   * 取消一个持久化子线程的当前 Turn
   */
  public async cancelChild(input: {
    /** 所属固定 Agent */
    agentId: string
    /** 子线程 ID */
    threadId: string
    /** 只取消匹配的子线程 Turn */
    turnId?: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    await this._assertThreadOwner(input)
    // 取消仍由子任务协调器统一处理排队、运行和等待交互的差异
    const { agentId, ...request } = input

    return this._entry(agentId).subagents.cancelChild(request)
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 控制操作必须命中当前存储中属于指定 Agent 的线程和 Turn
   */
  private async _assertThreadOwner(input: {
    /** 控制操作所属 Agent */
    agentId: string
    /** 控制操作目标线程 */
    threadId: string
    /** 需要命中的具体 Turn */
    turnId?: string
    /** 线程事实所在的存储 */
    store: RuntimeStore
  }) {
    this._entry(input.agentId)
    // 持久线程记录限定控制操作的 Agent 所有权
    const thread = await input.store.threads.read(input.threadId)

    if (!thread || thread.agentId !== input.agentId)
      throw new Error('线程不属于当前 Agent')
    if (input.turnId) {
      // 显式指定 Turn 时还需校验其线程与冻结 Agent 身份
      const turn = await input.store.turns.read(input.turnId)

      if (turn && (turn.threadId !== input.threadId || turn.agentSnapshot.id !== input.agentId))
        throw new Error('Turn 不属于当前线程或 Agent')
    }
  }

  /**
   * 在入口冻结本次提交的数据，异步准备不读取调用方后续修改
   */
  private _freezeRequest(options: TurnRequest): TurnRequest {
    return {
      ...options,
      location: Object.freeze({ ...options.location }),
      model: {
        adapter: options.model.adapter,
        // 使用与运行事实落库相同的 JSON 语义捕获模型，显式 undefined 不属于持久化配置
        config: Object.freeze(JSON.parse(JSON.stringify(options.model.config)) as typeof options.model.config),
      },
      input: typeof options.input === 'function' ? options.input : structuredClone(options.input),
      hiddenMessages: structuredClone(options.hiddenMessages),
      resume: structuredClone(options.resume),
    }
  }

  /**
   * 分离前台 Turn 的接纳确认与完整执行生命周期
   */
  private _runForeground(
    options: TurnRequest,
    operation: 'start' | 'resume',
    store: RuntimeStore,
  ): TurnExecution {
    // 接纳确认与执行完成分别暴露，HTTP 调用无需等到模型结束
    const accepted = Promise.withResolvers<void>()
    // 完整执行任务负责准备、运行和资源退出，失败会同时拒绝未完成的接纳确认
    const completed = this._executeRequest(options, operation, store, accepted.resolve)

    // 接纳前失败同时拒绝确认；接纳后失败只属于执行结果，不撤销已持久化的用户输入
    completed.catch(accepted.reject)
    // 调用方可以只等待 completed，未读取的确认失败不产生未处理拒绝
    accepted.promise.catch(() => undefined)
    return { accepted: accepted.promise, completed }
  }

  /**
   * 持有入口预留和项目占用，直到前台 Turn 完成执行与结算
   */
  private async _executeRequest(
    options: TurnRequest,
    operation: 'start' | 'resume',
    store: RuntimeStore,
    onAccepted: () => void,
  ) {
    // 前台执行同样在入口准备前持有工作区，退出结算后才释放
    const permit = this._acquireWorkspace?.(
      options.agentId,
      options.location.workspaceId,
    )
    // 线程预留防止异步模型和输入准备期间被另一个入口接管
    let reservation: TurnReservation

    try {
      reservation = this._turns.reserve(options.threadId, options.turnId)
    }
    catch (error) {
      permit?.release()
      throw error
    }
    // 准备成功后记录完整执行任务，以区分入口失败与正常资源移交
    let task: Promise<Message | undefined> | undefined

    try {
      // 输入、冻结配置与 Runtime 在进入前台执行前统一准备
      const prepared = await this._prepare(
        options,
        operation,
        reservation,
        store,
      )
      task = this._turns.track(
        reservation,
        () => this._executeForeground(prepared, onAccepted),
      )
    }
    finally {
      this._turns.release(reservation)

      if (!task)
        permit?.release()
    }

    try {
      return await task!
    }
    finally {
      permit?.release()
    }
  }

  /**
   * 解析持久身份并事务化准备一次 Turn
   */
  private async _prepare(
    options: TurnRequest,
    operation: 'start' | 'submit' | 'resume',
    reservation: TurnReservation,
    store: RuntimeStore,
  ) {
    // 当前 Agent 的执行器与协调器共同解释持久 Turn 身份
    const { executor, subagents } = this._entry(options.agentId)
    // 既有 Turn 和父子关系决定恢复状态与冻结角色，不能由请求覆盖
    const context = await subagents.prepare(options, store)

    if (context.turn && !deepEqual(options.model.config, context.turn.modelConfig))
      throw new Error('模型配置与当前 Turn 的冻结快照不一致')

    // 延迟输入在准备边界物化，后续执行只读取已解析内容
    const request: ResolvedTurnRequest = {
      ...options,
      input: typeof options.input === 'function'
        ? await options.input()
        : options.input,
    }
    // 同一线程运行使用缓存 Runtime，并绑定本次传入的事实存储
    const services: TurnServices = { runtime: this._runtime(options), store }

    return executor.prepare(request, {
      ...context,
      operation,
      reservation,
      services,
    })
  }

  /**
   * 获取或创建线程 Runtime
   */
  private _runtime(options: TurnRequest) {
    // Runtime 缓存以线程定位，但复用还需要 Agent 与执行位置匹配
    const { agentId, location, threadId } = options
    // 已有 Runtime 保留线程资源；位置变化时不能静默复用
    const current = this._runtimes.get(threadId)

    if (current) {
      if (current.agentId !== agentId || !deepEqual(current.runtime.location, location))
        throw new Error('线程 Runtime 的 Agent 或执行位置与当前请求不一致')
      return current.runtime
    }

    // 只有首次访问线程时才向宿主申请 Runtime
    const runtime = this._entry(agentId).createRuntime({ location })

    this._runtimes.set(threadId, { agentId, runtime })

    return runtime
  }

  /**
   * 等待前台 Turn，子线程恢复时仍需重新竞争子智能体并发槽
   */
  private _executeForeground(options: PreparedTurn, onAccepted: () => void) {
    // 子线程恢复需要重新争取所属 Agent 的 Turn 并发槽
    const { queues } = this._entry(options.agentSnapshot.id)

    return options.parentThreadId
      ? queues.turn.submit(
          options.turnId,
          () => this._execute(options, onAccepted),
          options.signal,
        )
      : this._execute(options, onAccepted)
  }

  /**
   * 为 Turn 装配辅助 Job 与可选子任务控制面并执行
   */
  private _execute(options: PreparedTurn, onAccepted?: () => void) {
    // 为当前切片取出同一 Agent 的执行、辅助队列与子任务能力
    const { executor, queues, subagents } = this._entry(options.agentSnapshot.id)
    // 只有根 Turn 可派生子任务，子线程不再持有递归派生控制面
    const controller = !options.parentThreadId
      ? subagents.createController(options)
      : undefined

    return executor.run(options, {
      onAccepted,
      hostServices: [
        provideHostService(auxQueueHostService, queues.aux),
        ...(controller
          ? [provideHostService(subagentHostService, controller)]
          : []),
      ],
      resolveAbortStatus: () => subagents.resolveAbortStatus(options.turnId),
      onRuntimeEvent: event => subagents.observeTurnEvent(options, event),
      onRootInterrupted: () => subagents.interruptChildren({
        parentTurnId: options.turnId,
        store: options.services.store,
      }),
    })
  }

  /**
   * 异步提交失败时结算仍处于 queued 的 Turn
   */
  private async _settleSubmittedFailure(
    options: PreparedTurn,
    error: unknown,
  ) {
    // 提交失败可能来自明确取消，先让协调器按实际取消事实结算
    const { subagents } = this._entry(options.agentSnapshot.id)

    if (await subagents.settleCancellation(options))
      return

    await this._settleQueuedFailure({
      agentId: options.agentSnapshot.id,
      threadId: options.threadId,
      turnId: options.turnId,
      store: options.services.store,
      error,
      onRuntimeEvent: options.onRuntimeEvent,
    })
  }

  /**
   * 将准备或调度阶段失败的持久 queued Turn 结算为 failed
   */
  private async _settleQueuedFailure(input: SettleQueuedFailureInput) {
    // 排队失败仍由原 Agent 的事务执行器固定终态
    const { executor, subagents } = this._entry(input.agentId)
    // 持久父子关系决定失败结果投影到父线程还是根线程未读状态
    const edge = await input.store.spawnEdges.readByChild(input.threadId)
    // 只有根任务失败需要提醒用户查看，子任务由父线程统一投影
    const markUnread = !edge
    // 将异常转换为稳定可存储的失败说明，不持久化异常对象
    const errorMessage = input.error instanceof Error
      ? input.error.message
      : String(input.error)
    // 只转换仍处于 queued 的记录，不能覆盖已运行或已完成的事实
    const settled = await executor.settleTurn({
      store: input.store,
      threadId: input.threadId,
      turnId: input.turnId,
      from: ['queued'],
      status: 'failed',
      threadStatus: 'failed',
      errorMessage,
      markUnread,
    })

    if (!settled)
      return

    if (edge) {
      await subagents.publishSettledTurn(input)
      return
    }

    try {
      await input.onRuntimeEvent?.(createRuntimeEvent({
        type: 'turn.failed',
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: settled,
        payload: {
          message: errorMessage,
          reason: errorMessage,
          unreadAt: settled,
        },
      }))
    }
    catch (error) {
      // 运行态通知失败不能覆盖已经固定的 queued Turn 失败事实
      console.warn('[engine] queued Turn 失败事件发布失败', error)
    }
  }

  /**
   * 读取固定 Agent 的执行能力
   */
  private _entry(agentId: string) {
    // 按注册身份获取固定执行能力，未知 Agent 不允许创建临时执行器
    const entry = this._entries.get(agentId)

    if (!entry)
      throw new Error(`Agent 不存在: ${agentId}`)

    return entry
  }
}
