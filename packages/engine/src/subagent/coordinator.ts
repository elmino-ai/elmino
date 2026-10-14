import type { Agent } from '@elmino/agent'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ThreadLocation } from '@elmino/runtime'
import type { Promisable, UnknownRecord } from '@elmino/shared'
import type { RuntimeStore, RuntimeThreadRecord, RuntimeTurnRecord, SubagentRole, ThreadMessage } from '@elmino/store'
import type { RuntimeEvent, ThreadChildState, ThreadInterrupt } from '@elmino/thread'
import type {
  SpawnSubagentRequest,
  SubagentController,
  SubagentResult,
  SubagentStatus,
  SubagentWaitInput,
  SubagentWaitResult,
} from '@elmino/tool'
import type { TurnControlRegistry } from '../engine/control.js'
import type { TurnExecutor } from '../engine/execution.js'
import type { JobQueue } from '../job/index.js'
import type { PreparedTurn, TurnHandle, TurnRequest } from '../turn/types.js'
import { extractText } from '@elmino/llm'
import { createId } from '@elmino/shared'
import {
  appendCanonicalMessage,
  canonicalRecordToMessage,
  createRuntimeEvent,
  readThreadInteraction,
  readThreadInterrupt,
} from '@elmino/thread'
import dayjs from 'dayjs'

/** -------------------- 类型 -------------------- */
/** Engine 注入的统一 Turn 提交入口 */
type SubmitTurn = (options: TurnRequest, store: RuntimeStore) => Promise<TurnHandle>

/** 子智能体协调器持有的稳定依赖 */
interface SubagentCoordinatorContext {
  /** 当前固定 Agent */
  agent: Agent
  /** 当前 Agent 的 Turn Job 队列 */
  turnQueue: JobQueue
  /** 进程内 Turn 控制面 */
  turns: TurnControlRegistry
  /** 单 Turn 执行与结算能力 */
  executor: TurnExecutor
  /** 解析当前子智能体角色目录 */
  resolveSubagentRoles: () => Promise<SubagentRole[]>
  /** 校验冻结配置并恢复可调用模型 */
  restoreModel?: (config: UnknownRecord) => Promise<TurnModel<ModelTurnConfig>>
  /** 宿主全局运行事件出口 */
  onRuntimeEvent?: (event: RuntimeEvent) => Promisable<void>
  /** Engine 统一 Turn 提交入口 */
  submit: SubmitTurn
}

/** 子任务状态及工具返回内容 */
interface ResolvedSubagent {
  /** 协议层通用子线程状态 */
  state: ThreadChildState
  /** 工具层查询结果 */
  result: SubagentResult
}

/** -------------------- 常量 -------------------- */
/** 子任务等待可以直接返回的稳定状态 */
const settledSubagentStatuses = new Set<SubagentStatus>([
  'waiting',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
])

/** 不再允许生命周期回退的子任务终态 */
const terminalSubagentStatuses = new Set<SubagentStatus>([
  'completed',
  'failed',
  'cancelled',
])

/** -------------------- 核心类 -------------------- */
/**
 * 管理子智能体的子线程关系、并发调度和状态投影
 */
export class SubagentCoordinator {
  /** 被明确取消且需要在执行协程退出后固定为 cancelled 的子线程 Turn */
  private readonly _cancelledTurns = new Set<string>()

  /**
   * 创建子智能体协调器
   */
  public static create(context: SubagentCoordinatorContext) {
    return new SubagentCoordinator(context)
  }

  /**
   * 保存 Runtime、进程控制和 Engine 提交入口
   */
  private constructor(
    private readonly _context: SubagentCoordinatorContext,
  ) {}

  /** -------------------- 核心方法 -------------------- */
  /**
   * 根据持久父子关系解析 Turn 身份
   */
  public async prepare(options: TurnRequest, store: RuntimeStore) {
    const [edge, turn, thread] = await Promise.all([
      store.spawnEdges.readByChild(options.threadId),
      store.turns.read(options.turnId),
      store.threads.read(options.threadId),
    ])
    const agentId = this._context.agent.id

    if (thread && thread.agentId !== agentId)
      throw new Error('线程不属于当前 Agent')
    if (
      thread && (
        thread.dir !== options.location.dir
        || (
          typeof thread.metadata.workspaceId === 'string'
          && thread.metadata.workspaceId !== options.location.workspaceId
        )
      )
    ) {
      throw new Error('线程执行位置与持久作用域不一致')
    }
    if (turn && (turn.threadId !== options.threadId || turn.agentSnapshot.id !== agentId))
      throw new Error('Turn 不属于当前线程或 Agent')
    if (edge && !turn)
      throw new Error('子线程缺少对应的持久 Turn')
    const parentThreadId = edge?.parentThreadId
    let subagentRole: SubagentRole
    let subagentRoles: SubagentRole[]

    // 已有 Turn 的角色与目录都是执行事实，恢复时不能重新读取可变的用户配置
    if (turn || parentThreadId) {
      subagentRole = turn!.subagentRole
      subagentRoles = turn!.subagentRoles
    }
    else {
      subagentRoles = await this._context.resolveSubagentRoles()
      const rootRole = subagentRoles.find(role => role.id === 'default')

      if (!rootRole)
        throw new Error('子智能体角色目录缺少 default')

      subagentRole = rootRole
    }

    return {
      turn,
      subagentRole,
      subagentRoles,
      parentThreadId,
    }
  }

  /**
   * 创建只属于当前根 Turn 的子智能体控制面
   */
  public createController(parent: PreparedTurn): SubagentController {
    const { store } = parent.services
    const signal = parent.control!.controller.signal

    /** 校验并读取等待请求指定的直接子任务 */
    const readRequested = async (threadIds: string[]) => {
      const children = await this._listFromStore(store, parent.threadId)
      const byThreadId = new Map(children.map(child => [child.state.threadId, child]))

      return threadIds.map((threadId) => {
        const child = byThreadId.get(threadId)

        if (!child)
          throw new Error(`子任务不属于当前线程: ${threadId}`)

        return child
      })
    }

    /** 无竞态地等待目标子任务状态变化，并绑定父 Turn 取消信号 */
    const waitForChange = async (
      threadIds: string[],
      timeoutMs: number,
      confirm: () => Promise<boolean>,
    ) => {
      // 先注册进程态监听，再二次读库，封住状态读取与订阅之间的变化窗口
      const waitController = new AbortController()
      const observed = Symbol('subagent-state-observed')
      /** 将父 Turn 取消同步到本次临时监听 */
      const abortWait = () => waitController.abort(signal.reason)

      if (signal.aborted)
        abortWait()
      else
        signal.addEventListener('abort', abortWait, { once: true })

      const waiting = this._context.turns.waitForSubagentChange(
        threadIds,
        timeoutMs,
        waitController.signal,
      )

      try {
        if (!await confirm())
          return await waiting

        waitController.abort(observed)

        try {
          await waiting
        }
        catch (error) {
          if (error !== observed)
            throw error
        }

        return false
      }
      finally {
        signal.removeEventListener('abort', abortWait)
      }
    }

    /** 等待目标子任务进入可观察稳定状态或本次超时 */
    const wait = async ({
      threadIds,
      timeoutMs,
    }: SubagentWaitInput): Promise<SubagentWaitResult> => {
      const current = await readRequested(threadIds)

      if (current.some(item => settledSubagentStatuses.has(item.result.status)))
        return { subagents: current.map(item => item.result) }

      const timedOut = await waitForChange(
        threadIds,
        timeoutMs,
        async () => (
          await readRequested(threadIds)
        ).some(item => settledSubagentStatuses.has(item.result.status)),
      )
      const subagents = (await readRequested(threadIds))
        .map(item => item.result)

      return {
        ...(timedOut ? { timedOut: true } : {}),
        subagents,
      }
    }

    return {
      spawn: request => this._spawn(parent, request),
      wait,
      list: async () => (
        await this._listFromStore(
          store,
          parent.threadId,
        )
      ).map(item => item.result),
      interrupt: async (threadId) => {
        const child = (await this._listFromStore(store, parent.threadId, false))
          .find(item => item.state.threadId === threadId)

        if (!child)
          throw new Error(`子任务不属于当前线程: ${threadId}`)

        if (!terminalSubagentStatuses.has(child.state.status)) {
          await this._cancel(
            store,
            threadId,
            child.state.turnId,
          )
        }

        const agent = (await this._readByTurn(store, child.state.turnId))?.result
          ?? child.result

        return agent
      },
    }
  }

  /**
   * 返回当前子任务取消信号应结算的 Turn 状态
   */
  public resolveAbortStatus(turnId: string) {
    return this._cancelledTurns.has(turnId)
      ? 'cancelled' as const
      : 'interrupted' as const
  }

  /**
   * 将子线程事件同步投影到父线程
   */
  public async observeTurnEvent(options: PreparedTurn, event: RuntimeEvent) {
    if (options.parentThreadId && event.type.startsWith('turn.')) {
      if (event.type !== 'turn.started') {
        this._cancelledTurns.delete(options.turnId)
        this._context.turns.notifySubagent(options.threadId)
      }

      await this._publishUpdate(
        options.services.store,
        options.turnId,
        options.onRuntimeEvent,
      )
    }
  }

  /**
   * 发布在调度或准备阶段失败的子智能体 Turn 终态
   */
  public async publishSubmittedFailure(
    input: Pick<
      TurnRequest,
      | 'threadId'
      | 'turnId'
      | 'onRuntimeEvent'
    > & {
      /** 当前项目事实存储 */
      store: RuntimeStore
    },
  ) {
    this._context.turns.notifySubagent(input.threadId)
    await this._publishUpdate(
      input.store,
      input.turnId,
      input.onRuntimeEvent,
    )
  }

  /**
   * 异步提交在排队阶段取消时固定 cancelled 终态
   */
  public async settleCancellation(options: PreparedTurn) {
    const explicitlyCancelled = this._cancelledTurns.has(options.turnId)
    const cancelledWhileQueued = Boolean(options.parentThreadId)
      && options.signal?.aborted

    if (!explicitlyCancelled && !cancelledWhileQueued)
      return false

    const endedAt = await this._markCancelled(
      options.services.store,
      options.threadId,
      options.turnId,
    )
    this._cancelledTurns.delete(options.turnId)

    if (endedAt) {
      this._context.turns.notifySubagent(options.threadId)
      await this._publishCancelledTurn(
        options.threadId,
        options.turnId,
        endedAt,
        options.onRuntimeEvent,
      )
      await this._publishUpdate(
        options.services.store,
        options.turnId,
        options.onRuntimeEvent,
      )
    }

    return true
  }

  /**
   * 结算孤立 Turn，并重新提交可恢复的 queued 子线程
   */
  public async recoverWorkspace(input: {
    /** 当前项目事实存储 */
    store: RuntimeStore
    /** 在真正恢复 queued 子线程前解析其完整执行位置 */
    resolveThreadLocation: (
      thread: Pick<RuntimeThreadRecord, 'id' | 'dir'>,
    ) => Promise<ThreadLocation>
    /** 是否重新提交可恢复的 queued 子线程 */
    resumeQueuedChildren?: boolean
  }) {
    const { store } = input
    const threadEdges = await store.spawnEdges.list()
    const childThreadIds = new Set(threadEdges.map(edge => edge.childThreadId))
    const [threads, turns] = await Promise.all([
      store.threads.listAll(),
      store.turns.listAll(),
    ])
    const threadById = new Map(
      threads.filter(thread => thread.agentId === this._context.agent.id)
        .map(thread => [thread.id, thread]),
    )

    for (const turn of turns) {
      const thread = threadById.get(turn.threadId)

      if (!thread || turn.agentSnapshot.id !== this._context.agent.id)
        continue
      if (this._context.turns.owns(thread.id, turn.id))
        continue
      const isChild = childThreadIds.has(thread.id)

      if (
        turn.status === 'running'
        && this._context.turns.get(thread.id)?.turnId !== turn.id
      ) {
        const interrupted = await this._interruptOrphanedTurn(
          store,
          thread,
          turn,
          'running',
        )

        if (interrupted) {
          this._context.turns.notifySubagent(thread.id)
          await this._publishUpdate(
            store,
            turn.id,
          )
        }
        continue
      }

      // 根 Turn 没有持久调度器；物理项目丢失时子线程也只能结算，不能重新创建关联目录
      if (
        turn.status === 'queued'
        && (!isChild || input.resumeQueuedChildren === false)
      ) {
        const interrupted = await this._interruptOrphanedTurn(
          store,
          thread,
          turn,
          'queued',
        )

        if (interrupted) {
          this._context.turns.notifySubagent(thread.id)
          await this._publishUpdate(
            store,
            turn.id,
          )
        }
        continue
      }

      if (turn.status !== 'queued' || !isChild)
        continue

      if (!this._context.restoreModel)
        continue

      try {
        const location = await input.resolveThreadLocation(thread)
        const model = await this._context.restoreModel(turn.modelConfig)

        if (this._context.turns.owns(thread.id, turn.id))
          continue
        await this._context.submit({
          agentId: thread.agentId,
          model,
          threadId: thread.id,
          turnId: turn.id,
          location,
          approvalMode: turn.approvalMode,
          subagentMode: turn.subagentMode,
          input: [],
          onRuntimeEvent: this._context.onRuntimeEvent,
        }, store)
      }
      catch (error) {
        if (this._context.turns.owns(thread.id, turn.id))
          continue
        const failed = await this._context.executor.settleTurn({
          store,
          threadId: thread.id,
          turnId: turn.id,
          shouldSettle: () => !this._context.turns.owns(thread.id, turn.id),
          from: ['queued'],
          status: 'failed',
          threadStatus: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })

        if (!failed)
          continue

        this._context.turns.notifySubagent(thread.id)
        await this._publishUpdate(
          store,
          turn.id,
        )
      }
    }
  }

  /**
   * 取消指定父 Turn 发起的全部非终态子线程
   */
  public async interruptChildren(input: {
    /** 父 Turn ID */
    parentTurnId: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    const { store } = input
    const edges = await store.turnSpawnEdges.listChildren(input.parentTurnId)

    for (const edge of edges) {
      const child = await this._readByTurn(store, edge.childTurnId, false)

      if (child && !terminalSubagentStatuses.has(child.state.status)) {
        await this._cancel(
          store,
          child.state.threadId,
          child.state.turnId,
        )
      }
    }
  }

  /**
   * 读取父线程直接派生的通用子线程状态
   */
  public async listChildren(input: {
    /** 父线程 ID */
    parentThreadId: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    return (await this._listFromStore(
      input.store,
      input.parentThreadId,
      false,
    ))
      .map(item => item.state)
  }

  /**
   * 取消一个持久化子线程的当前 Turn
   */
  public async cancelChild(input: {
    /** 子线程 ID */
    threadId: string
    /** 只取消匹配的子线程 Turn */
    turnId?: string
    /** 当前项目事实存储 */
    store: RuntimeStore
  }) {
    const { store } = input
    const edge = await store.spawnEdges.readByChild(input.threadId)

    if (!edge)
      return false

    const child = (await this._listFromStore(store, edge.parentThreadId, false))
      .find(item => item.state.threadId === input.threadId)

    if (
      child
      && (!input.turnId || child.state.turnId === input.turnId)
      && !terminalSubagentStatuses.has(child.state.status)
    ) {
      await this._cancel(
        store,
        input.threadId,
        child.state.turnId,
      )

      return true
    }

    return false
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 将失去进程控制器的 Turn、工具和线程统一结算为系统中断
   */
  private async _interruptOrphanedTurn(
    store: RuntimeStore,
    thread: RuntimeThreadRecord,
    turn: RuntimeTurnRecord,
    from: 'queued' | 'running',
  ) {
    const endedAt = dayjs().toISOString()
    const reason = '服务重启中断了未完成的运行'
    const interrupt: ThreadInterrupt = {
      id: createId('interrupt'),
      kind: 'system',
      status: 'pending',
      turnId: turn.id,
      reason,
      createdAt: endedAt,
      resumableWith: ['message'],
    }
    const runningSteps = (await store.steps.list(turn.id))
      .filter(step => step.status === 'running')

    if (this._context.turns.owns(thread.id, turn.id))
      return
    const interruptedTurn = await this._context.executor.settleTurn({
      store,
      threadId: thread.id,
      turnId: turn.id,
      shouldSettle: () => !this._context.turns.owns(thread.id, turn.id),
      from: [from],
      status: 'interrupted',
      threadStatus: 'interrupted',
      endedAt,
      errorMessage: reason,
      interrupt,
      onSettled: async (tx, settledAt) => {
        for (const step of runningSteps) {
          await tx.steps.settle(step.id, {
            status: 'interrupted',
            input: step.input,
            output: step.output,
            reasoning: step.reasoning,
            cacheWrite: step.cacheWrite,
            cacheRead: step.cacheRead,
            estimated: step.estimated,
            endedAt: settledAt,
          })
        }
      },
    })

    return interruptedTurn
  }

  /**
   * 事务化创建子线程、queued Turn、输入消息和两类派生关系
   */
  private async _spawn(
    parent: PreparedTurn,
    request: SpawnSubagentRequest,
  ): Promise<SubagentResult> {
    const subagentRole = parent.subagentRoles.find(role => role.id === request.role)

    if (!subagentRole)
      throw new Error(`未知子智能体角色: ${request.role}`)

    const { store } = parent.services
    const threadId = createId('thread')
    const turnId = createId('turn')
    const now = dayjs().toISOString()
    const text = request.description
    const contextMessages = [{
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    }]

    const spawned = await store.transaction(async (tx) => {
      const existingEdge = await tx.turnSpawnEdges
        .readByParentToolCall(request.parentToolCallId)

      if (existingEdge) {
        const existingTurn = (await tx.turns.read(existingEdge.childTurnId))!
        const { id: turnId, status, threadId } = existingTurn

        return {
          created: false as const,
          threadId,
          turnId,
          status,
        }
      }

      const parentThread = (await tx.threads.read(parent.threadId))!

      await tx.threads.upsert({
        id: threadId,
        dir: parent.location.dir,
        userTitle: request.name,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        lastInteractionAt: now,
        settings: {
          modelId: parent.model.config.id,
          reasoningLevel: parent.model.config.reasoning?.level,
          approvalMode: parent.approvalMode,
          subagentMode: 'explicitOnly',
          pluginSettings: parentThread.settings.pluginSettings,
        },
        agentId: parent.agentSnapshot.id,
        metadata: {
          workspaceId: parent.location.workspaceId,
        },
        state: {
          contextProjection: {},
          extensionState: {},
        },
      })
      await tx.turns.create({
        id: turnId,
        threadId,
        status: 'queued',
        modelConfig: { ...parent.model.config },
        subagentRole,
        subagentRoles: [],
        agentSnapshot: { ...parent.agentSnapshot },
        approvalMode: parent.approvalMode,
        subagentMode: 'explicitOnly',
        createdAt: now,
      })
      const messageId = createId('msg')
      const partId = createId('part')
      const transcript: ThreadMessage = {
        id: messageId,
        threadId,
        turnId,
        role: 'user',
        kind: 'normal',
        status: 'completed',
        parts: [{
          id: partId,
          messageId,
          threadId,
          turnId,
          seq: 1,
          type: 'text',
          status: 'completed',
          text,
          createdAt: now,
          updatedAt: now,
        }],
        createdAt: now,
        updatedAt: now,
        metadata: {},
      }

      await tx.transcript.upsert(transcript)
      await appendCanonicalMessage(tx, {
        threadId,
        turnId,
        message: contextMessages[0]!,
      })
      await tx.spawnEdges.create({
        childThreadId: threadId,
        ownerId: request.ownerId,
        parentThreadId: parent.threadId,
        createdAt: now,
      })
      await tx.turnSpawnEdges.create({
        childTurnId: turnId,
        parentToolCallId: request.parentToolCallId,
        createdAt: now,
      })

      return {
        created: true as const,
        threadId,
        turnId,
        status: 'queued' as const,
      }
    })

    if (!spawned.created) {
      const scheduled = this._context.turnQueue.status(spawned.turnId)

      if (spawned.status !== 'queued' || scheduled) {
        const existing = await this._readByTurn(store, spawned.turnId)

        return existing!.result
      }
    }

    if (spawned.created) {
      await this._publishUpdate(
        store,
        spawned.turnId,
        parent.onRuntimeEvent,
      )
    }

    try {
      await this._context.submit({
        agentId: parent.agentSnapshot.id,
        model: parent.model,
        threadId: spawned.threadId,
        turnId: spawned.turnId,
        location: parent.location,
        approvalMode: parent.approvalMode,
        subagentMode: 'explicitOnly',
        input: [],
        onRuntimeEvent: parent.onRuntimeEvent,
        signal: parent.control?.controller.signal,
      }, store)
    }
    catch (error) {
      if (this._context.turns.owns(spawned.threadId, spawned.turnId)) {
        const existing = await this._readByTurn(store, spawned.turnId)

        if (existing)
          return existing.result
      }
      // 只有本次创建且未被执行器接管的子 Turn，才属于当前 spawn 的失败结算范围
      if (
        spawned.created
        && !this._context.turnQueue.status(spawned.turnId)
        && !this._context.turns.owns(spawned.threadId, spawned.turnId)
      ) {
        const failed = await this._context.executor.settleTurn({
          store,
          threadId: spawned.threadId,
          turnId: spawned.turnId,
          shouldSettle: () => !this._context.turns.owns(spawned.threadId, spawned.turnId),
          from: ['queued'],
          status: 'failed',
          threadStatus: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })

        if (failed) {
          this._context.turns.notifySubagent(spawned.threadId)
          await this._publishUpdate(store, spawned.turnId, parent.onRuntimeEvent)
        }
      }
      throw error
    }

    return (await this._readByTurn(store, spawned.turnId))!.result
  }

  /**
   * 批量读取父线程的直接子线程与最新 Turn，需要工具结果时再加载 transcript
   */
  private async _listFromStore(
    store: RuntimeStore,
    parentThreadId: string,
    includeResult = true,
  ) {
    const records = await store.spawnEdges.listChildrenWithLatestTurn(parentThreadId)
    const children = await Promise.all(records.map(async ({ ownerId, thread, turn, parentToolCallId }) => (
      this._resolve(
        ownerId,
        thread,
        turn,
        parentToolCallId,
        includeResult ? await this._readResultText(store, thread.id) : '',
      )
    )))

    return children.sort((left, right) => (
      left.state.createdAt.localeCompare(right.state.createdAt)
    ))
  }

  /**
   * 按子线程 Turn 直接读取结构化子任务状态
   */
  private async _readByTurn(
    store: RuntimeStore,
    childTurnId: string,
    includeResult = true,
  ) {
    const [turnEdge, turn] = await Promise.all([
      store.turnSpawnEdges.readByChildTurn(childTurnId),
      store.turns.read(childTurnId),
    ])

    if (!turnEdge || !turn)
      return

    const [edge, thread] = await Promise.all([
      store.spawnEdges.readByChild(turn.threadId),
      store.threads.read(turn.threadId),
    ])

    if (!edge || !thread)
      return

    return this._resolve(
      edge.ownerId,
      thread,
      turn,
      turnEdge.parentToolCallId,
      includeResult ? await this._readResultText(store, thread.id) : '',
    )
  }

  /**
   * 合并子线程、Turn 和派生边形成对外状态
   */
  private _resolve(
    ownerId: string,
    thread: RuntimeThreadRecord,
    turn: RuntimeTurnRecord,
    parentToolCallId: string,
    text: string,
  ): ResolvedSubagent {
    const title = thread.title
    const interrupt = readThreadInterrupt(turn.interrupt)
    const interaction = readThreadInteraction(interrupt)
    const status = turn.status === 'interrupted'
      && interaction?.status === 'pending'
      ? 'waiting'
      : turn.status
    const state: ThreadChildState = {
      ownerId,
      threadId: thread.id,
      turnId: turn.id,
      parentToolCallId,
      title,
      status: turn.status,
      ...(interrupt ? { interrupt } : {}),
      data: {
        role: {
          id: turn.subagentRole.id,
          name: turn.subagentRole.name,
          icon: turn.subagentRole.icon,
        },
      },
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      updatedAt: turn.updatedAt,
    }

    return {
      state,
      result: {
        threadId: thread.id,
        turnId: turn.id,
        name: title ?? turn.subagentRole.name,
        status,
        result: turn.status === 'completed' && text ? text : undefined,
        error: turn.status === 'failed' ? turn.errorMessage ?? undefined : undefined,
      },
    }
  }

  /**
   * 从 Canonical 历史读取子任务最后一条 assistant 结果
   */
  private async _readResultText(store: RuntimeStore, threadId: string) {
    const [messages, parts] = await Promise.all([
      store.canonical.list(threadId),
      store.canonical.listParts(threadId),
    ])
    const assistant = messages.findLast(message => message.role === 'assistant')

    if (!assistant)
      return ''

    const hydrated = await store.canonical.readParts(
      threadId,
      parts.filter(part => part.messageId === assistant.id).map(part => part.id),
    )

    return extractText(canonicalRecordToMessage({ ...assistant, parts: hydrated })).trim()
  }

  /**
   * 取消 queued、running 或 waiting 子任务并固定终态
   */
  private async _cancel(
    store: RuntimeStore,
    childThreadId: string,
    childTurnId: string,
  ) {
    this._cancelledTurns.add(childTurnId)
    const cancelledJob = this._context.turnQueue.cancel(childTurnId, 'cancelled')
    const active = this._context.turns.get(childThreadId)

    if (active) {
      this._context.turns.interrupt(childThreadId, 'cancelled', childTurnId)
    }
    else {
      const endedAt = await this._markCancelled(
        store,
        childThreadId,
        childTurnId,
      )

      if (endedAt) {
        this._context.turns.notifySubagent(childThreadId)
        await this._publishCancelledTurn(childThreadId, childTurnId, endedAt)
        await this._publishUpdate(
          store,
          childTurnId,
        )
      }
    }

    // 删除线程前必须等模型、工具和异步失败结算全部退出，避免迟到快照复活记录
    await this._context.turns.waitForCompletion(childThreadId, childTurnId)

    if (!cancelledJob && !active)
      this._cancelledTurns.delete(childTurnId)
  }

  /**
   * 将子线程 Turn 和线程状态结算为 cancelled
   */
  private _markCancelled(
    store: RuntimeStore,
    childThreadId: string,
    childTurnId: string,
  ) {
    return this._context.executor.settleTurn({
      store,
      threadId: childThreadId,
      turnId: childTurnId,
      from: ['queued', 'running', 'interrupted'],
      status: 'cancelled',
      threadStatus: 'interrupted',
      errorMessage: '子任务已取消',
    })
  }

  /**
   * 发布子线程 Turn 取消事件并隔离非权威通知失败
   */
  private async _publishCancelledTurn(
    threadId: string,
    turnId: string,
    endedAt: string,
    emit = this._context.onRuntimeEvent,
  ) {
    if (!emit)
      return

    try {
      await emit(createRuntimeEvent({
        type: 'turn.cancelled',
        threadId,
        turnId,
        createdAt: endedAt,
        payload: {
          message: '子任务已取消',
          reason: '子任务已取消',
          threadStatus: 'interrupted',
        },
      }))
    }
    catch (error) {
      // 运行态事件通知失败不能回滚已经固定的 Turn 终态
      console.warn('[subagent] Turn 取消事件发布失败', error)
    }
  }

  /**
   * 发布父线程作用域的完整子线程状态
   */
  private async _publishUpdate(
    store: RuntimeStore,
    childTurnId: string,
    emit = this._context.onRuntimeEvent,
  ) {
    if (!emit)
      return

    try {
      const child = await this._readByTurn(store, childTurnId, false)

      if (!child)
        return

      const edge = await store.spawnEdges.readByChild(child.state.threadId)

      if (!edge)
        return

      await emit(createRuntimeEvent({
        type: 'thread.child.updated',
        threadId: edge.parentThreadId,
        payload: child.state,
      }))
    }
    catch (error) {
      // 运行态事件通知不是调度事实，失败时仍必须继续提交或结算子线程
      console.warn('[subagent] 状态事件发布失败', error)
    }
  }
}
