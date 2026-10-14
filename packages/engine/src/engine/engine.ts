import type { Agent } from '@elmino/agent'
import type { Message } from '@elmino/llm'
import type { TurnRuntimeEventHandler, TurnServices } from '@elmino/loop'
import type { Runtime, ThreadLocation } from '@elmino/runtime'
import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import type { PreparedTurn, ResolvedTurnRequest, TurnExecution, TurnHandle, TurnRequest } from '../turn/types.js'
import type { TurnReservation } from './control.js'
import type { AgentEngineOptions, RuntimeFactoryContext, WorkspaceAccessAcquirer } from './options.js'
import { deepEqual, objectValues, throwSettledErrors } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread'
import { auxQueueHostService, provideHostService, subagentHostService } from '@elmino/tool'
import { JobQueue } from '../job/index.js'
import { SubagentCoordinator } from '../subagent/coordinator.js'
import { getBuiltinSubagentRoles } from '../subagent/roles.js'
import { TurnControlRegistry } from './control.js'
import { TurnExecutor } from './execution.js'
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
    const {
      acquireWorkspace,
      createRuntime: runtimeFactory,
      onRuntimeEvent: emitRuntimeEvent,
      resolveSubagentRoles = () => Promise.resolve(getBuiltinSubagentRoles()),
      restoreModel,
    } = options
    const turns = this._turns
    /** 将子智能体请求提交回当前 Engine */
    const submit = this.submit.bind(this)

    this._acquireWorkspace = acquireWorkspace

    for (const agent of objectValues(agents)) {
      const queues = {
        turn: JobQueue.create(4),
        aux: JobQueue.create(4),
      }
      const turnQueue = queues.turn
      const executor = TurnExecutor.create(agent, turns)
      /** 将宿主 Runtime 工厂绑定到当前 Agent */
      const createRuntime = (context: RuntimeFactoryContext) => runtimeFactory
        ? runtimeFactory(agent, context)
        : agent.runtime.create({ agentId: agent.id, ...context })
      const onRuntimeEvent = emitRuntimeEvent?.bind(undefined, agent.id)

      const subagents = SubagentCoordinator.create({
        agent,
        turnQueue,
        turns,
        executor,
        resolveSubagentRoles,
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
    const permit = this._acquireWorkspace?.(
      options.agentId,
      options.location.workspaceId,
    )
    let reservation: TurnReservation

    try {
      reservation = this._turns.reserve(options.threadId, options.turnId)
    }
    catch (error) {
      permit?.release()
      throw error
    }
    let releaseOnReturn = true
    /** 后台 Turn 结束后释放项目占用 */
    const releaseWorkspace = () => permit?.release()

    try {
      const prepared = await this._prepare(
        options,
        'submit',
        reservation,
        store,
      )
      const { agentSnapshot, signal, threadId, turnId, turnStatus } = prepared
      const { queues } = this._entry(agentSnapshot.id)
      /** 执行已经完成准备的 Turn */
      const execute = () => this._execute(prepared)
      if (turnStatus === 'running')
        throw new Error(`Turn 正在由其他执行器处理: ${turnId}`)

      const task = this._turns.track(reservation, () => queues.turn
        .submit(turnId, execute, signal)
        .catch(error => this._settleSubmittedFailure(prepared, error))
        .finally(releaseWorkspace))

      releaseOnReturn = false
      task.catch((error) => {
        console.error('后台 Turn 结算失败', error)
      })
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
    const entries = [...this._runtimes].filter(
      ([threadId]) => !threadIds || threadIds.includes(threadId),
    )
    const results = await Promise.allSettled(
      entries.map(([, entry]) => entry.runtime.dispose()),
    )

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
      const jobClosings = [...this._entries.values()].flatMap(entry => [
        entry.queues.turn.close(),
        entry.queues.aux.close(),
      ])
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
    const active = this._turns.get(input.threadId)

    if (active) {
      if (active.agentId !== input.agentId || active.store !== input.store)
        throw new Error('活跃 Turn 不属于当前 Agent 或存储')
    }
    else {
      await this._assertThreadOwner(input)
    }
    const { agentId, ...request } = input
    const entry = this._entry(agentId)
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
    resolveThreadLocation: (
      thread: { id: string, dir: string },
    ) => Promise<ThreadLocation>
    /** 是否重新提交可恢复的 queued 子线程 */
    resumeQueuedChildren?: boolean
  }) {
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
    const { agentId, ...request } = input

    return this._entry(agentId).subagents.cancelChild(request)
  }

  /** -------------------- 辅助方法 -------------------- */
  /** 控制操作必须命中当前存储中属于指定 Agent 的线程和 Turn */
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
    const thread = await input.store.threads.read(input.threadId)

    if (!thread || thread.agentId !== input.agentId)
      throw new Error('线程不属于当前 Agent')
    if (input.turnId) {
      const turn = await input.store.turns.read(input.turnId)

      if (turn && (turn.threadId !== input.threadId || turn.agentSnapshot.id !== input.agentId))
        throw new Error('Turn 不属于当前线程或 Agent')
    }
  }

  /** 在入口冻结本次提交的数据，异步准备不读取调用方后续修改 */
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
    const accepted = Promise.withResolvers<void>()
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
    const permit = this._acquireWorkspace?.(
      options.agentId,
      options.location.workspaceId,
    )
    let reservation: TurnReservation

    try {
      reservation = this._turns.reserve(options.threadId, options.turnId)
    }
    catch (error) {
      permit?.release()
      throw error
    }
    let task: Promise<Message | undefined> | undefined

    try {
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
    const { executor, subagents } = this._entry(options.agentId)
    const context = await subagents.prepare(options, store)

    if (context.turn && !deepEqual(options.model.config, context.turn.modelConfig))
      throw new Error('模型配置与当前 Turn 的冻结快照不一致')

    const request: ResolvedTurnRequest = {
      ...options,
      input: typeof options.input === 'function'
        ? await options.input()
        : options.input,
    }
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
    const { agentId, location, threadId } = options
    const current = this._runtimes.get(threadId)

    if (current) {
      if (current.agentId !== agentId || !deepEqual(current.runtime.location, location))
        throw new Error('线程 Runtime 的 Agent 或执行位置与当前请求不一致')
      return current.runtime
    }

    const runtime = this._entry(agentId).createRuntime({ location })

    this._runtimes.set(threadId, { agentId, runtime })

    return runtime
  }

  /**
   * 等待前台 Turn，子线程恢复时仍需重新竞争子智能体并发槽
   */
  private _executeForeground(options: PreparedTurn, onAccepted: () => void) {
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
    const { executor, queues, subagents } = this._entry(options.agentSnapshot.id)
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
    const { executor, subagents } = this._entry(input.agentId)
    const edge = await input.store.spawnEdges.readByChild(input.threadId)
    const markUnread = !edge
    const errorMessage = input.error instanceof Error
      ? input.error.message
      : String(input.error)
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
      await subagents.publishSubmittedFailure(input)
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
    const entry = this._entries.get(agentId)

    if (!entry)
      throw new Error(`Agent 不存在: ${agentId}`)

    return entry
  }
}
