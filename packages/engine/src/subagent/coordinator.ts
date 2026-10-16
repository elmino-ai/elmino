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
import type { TurnControlRegistry } from '../engine/control'
import type { TurnExecutor } from '../engine/execution'
import type { JobQueue } from '../job/index'
import type { PreparedTurn, TurnHandle, TurnRequest } from '../turn/types'
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
  subagentRoles: () => Promisable<SubagentRole[]>
  /** 校验冻结配置并恢复可调用模型 */
  restoreModel?: (config: UnknownRecord) => Promisable<TurnModel<ModelTurnConfig>>
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
    // 并行读取线程与 Turn 的派生关系，确定请求是根执行还是子执行
    const [edge, turn, thread] = await Promise.all([
      store.spawnEdges.readByChild(options.threadId),
      store.turns.read(options.turnId),
      store.threads.read(options.threadId),
    ])
    // 协调器只服务创建时固定的 Agent，持久归属必须与之匹配
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
    // 持久派生边决定父线程身份，请求不能自行声明父子关系
    const parentThreadId = edge?.parentThreadId
    // 当前角色在恢复时沿用原 Turn，新根执行才从目录选择
    let subagentRole: SubagentRole
    // 可派生角色目录同样冻结于原根 Turn，恢复时不重新加载用户配置
    let subagentRoles: SubagentRole[]

    // 已有 Turn 的角色与目录都是执行事实，恢复时不能重新读取可变的用户配置
    if (turn || parentThreadId) {
      subagentRole = turn!.subagentRole
      subagentRoles = turn!.subagentRoles
    }
    else {
      subagentRoles = await this._context.subagentRoles()
      // 新根执行必须有 default 角色，保证根任务角色快照完整
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
    // 子任务控制面始终使用父 Turn 的事实存储
    const { store } = parent.services
    // 等待和派生执行都绑定父任务控制器，父任务停止后不能继续等待
    const signal = parent.control!.controller.signal

    /** 校验并读取等待请求指定的直接子任务 */
    const readRequested = async (threadIds: string[]) => {
      // 等待请求只能访问当前父线程实际拥有的直接子任务
      const children = await this._listFromStore(store, parent.threadId)
      // 按线程身份索引，保持返回顺序与调用方请求顺序一致
      const byThreadId = new Map(children.map(child => [child.state.threadId, child]))

      return threadIds.map((threadId) => {
        // 逐个校验被请求的子任务归属，未知线程不能进入等待集合
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
      // 二次读取已发现稳定状态时，用独立标记结束临时等待
      const observed = Symbol('subagent-state-observed')
      /** 将父 Turn 取消同步到本次临时监听 */
      const abortWait = () => waitController.abort(signal.reason)

      if (signal.aborted)
        abortWait()
      else
        signal.addEventListener('abort', abortWait, { once: true })

      // 先登记变化监听，封住读取状态与等待之间的丢失通知窗口
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
      // 先读一次目标状态，已有可观察结果时无需建立等待
      const current = await readRequested(threadIds)

      if (current.some(item => settledSubagentStatuses.has(item.result.status)))
        return { subagents: current.map(item => item.result) }

      // 超时只结束本次等待，不会取消被观察的子任务
      const timedOut = await waitForChange(
        threadIds,
        timeoutMs,
        async () => (
          await readRequested(threadIds)
        ).some(item => settledSubagentStatuses.has(item.result.status)),
      )
      // 等待结束后重新读取事实，返回最新状态而非最初的缓存
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
        // 父控制面取消前再次确认目标仍是自己的直接子任务
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

        // 取消后优先重新读取持久结果；未产生新事实时保留原展示信息
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
   * 发布进程外结算或调度失败后的子智能体 Turn 状态
   */
  public async publishSettledTurn(
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
    // 明确取消标记可以区别于普通父信号中断，用于固定 cancelled 状态
    const explicitlyCancelled = this._cancelledTurns.has(options.turnId)
    // 尚未取得执行槽的子任务也需要在父信号取消后完成持久结算
    const cancelledWhileQueued = Boolean(options.parentThreadId)
      && options.signal?.aborted

    if (!explicitlyCancelled && !cancelledWhileQueued)
      return false

    // 使用统一结算入口关闭原运行、工具与线程状态
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
    threadLocation: (
      thread: Pick<RuntimeThreadRecord, 'id' | 'dir'>,
    ) => Promisable<ThreadLocation>
    /** 是否重新提交可恢复的 queued 子线程 */
    resumeQueuedChildren?: boolean
  }) {
    // 恢复只操作宿主明确提供的工作区存储
    const { store } = input
    // 线程派生关系用于区分可重调度子任务与没有持久调度器的根任务
    const threadEdges = await store.spawnEdges.list()
    // 按子线程身份快速判断每条 Turn 的恢复策略
    const childThreadIds = new Set(threadEdges.map(edge => edge.childThreadId))
    // 工作区全部线程与运行事实构成启动恢复的唯一状态来源
    const [threads, turns] = await Promise.all([
      store.threads.listAll(),
      store.turns.listAll(),
    ])
    // 过滤到当前固定 Agent，避免恢复其他 Agent 拥有的运行
    const threadById = new Map(
      threads.filter(thread => thread.agentId === this._context.agent.id)
        .map(thread => [thread.id, thread]),
    )

    // 逐个检查持久 Turn，已经被本进程接纳的执行保持不动
    for (const turn of turns) {
      // 运行只有仍归属于当前 Agent 的线程时才可恢复或结算
      const thread = threadById.get(turn.threadId)

      if (!thread || turn.agentSnapshot.id !== this._context.agent.id)
        continue
      if (this._context.turns.owns(thread.id, turn.id))
        continue
      // 只有带持久父子关系的 queued 任务才有重提交依据
      const isChild = childThreadIds.has(thread.id)

      if (
        turn.status === 'running'
        && this._context.turns.get(thread.id)?.turnId !== turn.id
      ) {
        // 失去控制器的 running 任务统一结算为可观察的系统中断
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
        // 不可重调度的 queued 记录也要固定中断，不能永久停留在排队状态
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
        // 真正重提交前解析原线程位置，缺失项目不能静默创建新目录
        const location = await input.threadLocation(thread)
        // 模型按原 Turn 冻结配置重建，不能使用宿主当前默认模型
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
        // 准备或重调度失败时只结算仍无人拥有的 queued Turn
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
    // 级联取消继续使用父 Turn 所属的同一事实存储
    const { store } = input
    // 按父 Turn 查询派生边，避免误取消同线程其他轮次产生的子任务
    const edges = await store.turnSpawnEdges.listChildren(input.parentTurnId)

    // 逐个处理该父 Turn 实际派生的子运行
    for (const edge of edges) {
      // 读取子任务当前状态，已终结的任务无需再次取消
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
    // 显式取消子线程时，派生关系和状态均从同一存储读取
    const { store } = input
    // 只有真实子线程才进入子任务取消路径，根线程返回未处理
    const edge = await store.spawnEdges.readByChild(input.threadId)

    if (!edge)
      return false

    // 在父线程当前子任务集合中定位目标，保留准确 Turn 匹配约束
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
    // 孤立运行结算使用统一结束时间，运行和 Step 共享这个时间
    const endedAt = dayjs().toISOString()
    // 系统中断原因明确来自服务重启，不混同用户取消或工具失败
    const reason = '服务重启中断了未完成的运行'
    // 为失去进程控制器的运行建立持久系统中断身份
    const interrupt: ThreadInterrupt = {
      id: createId('interrupt'),
      kind: 'system',
      status: 'pending',
      turnId: turn.id,
      reason,
      createdAt: endedAt,
      resumableWith: ['message'],
    }
    // 只收口原 Turn 尚在运行的 Step，已结束采样保持原状
    const runningSteps = (await store.steps.list(turn.id))
      .filter(step => step.status === 'running')

    if (this._context.turns.owns(thread.id, turn.id))
      return
    // 结算前后都检查进程所有权，避免启动恢复覆盖刚接纳的新执行
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
        // 同一事务内收口所有孤立的运行中 Step，不留下永远运行的采样记录
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
    // 角色只能从父 Turn 冻结目录选择，不能临时注入未授权角色
    const subagentRole = parent.subagentRoles.find(role => role.id === request.role)

    if (!subagentRole)
      throw new Error(`未知子智能体角色: ${request.role}`)

    // 子线程沿用父任务所属的事实存储与工作区边界
    const { store } = parent.services
    // 每次新派生生成独立线程身份，和根会话消息分开持久化
    const threadId = createId('thread')
    // 新子线程的首轮运行有独立 Turn 身份，用派生边关联原工具调用
    const turnId = createId('turn')
    // 子线程、运行、输入和派生边共用创建时间
    const now = dayjs().toISOString()
    // 派生描述同时作为子任务输入和初始上下文内容
    const text = request.description
    // 只为子任务建立本次描述输入，不复制父线程的完整消息历史
    const contextMessages = [{
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    }]

    // 创建子线程及两类派生关系必须原子提交，避免恢复时出现半份关系
    const spawned = await store.transaction(async (tx) => {
      // 父工具调用已派生过任务时直接复用，保证重复调用不会新增子线程
      const existingEdge = await tx.turnSpawnEdges
        .readByParentToolCall(request.parentToolCallId)

      if (existingEdge) {
        // 已存在派生边时读取原 Turn，保持原执行身份和状态
        const existingTurn = (await tx.turns.read(existingEdge.childTurnId))!
        // 复用记录的线程与运行身份，后续调度不能改用新生成的身份
        const { id: turnId, status, threadId } = existingTurn

        return {
          created: false as const,
          threadId,
          turnId,
          status,
        }
      }

      // 子任务继承父线程工作区与插件配置，但持有自己的上下文状态
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
      // 子任务的初始用户消息具有独立展示身份
      const messageId = createId('msg')
      // 初始描述使用独立片段身份，便于事件和历史投影定位
      const partId = createId('part')
      // 初始消息归属于新子 Turn，展示与 Canonical 上下文在事务内一起落库
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
      // 重复派生时检查原任务是否已经排队，防止再次提交同一 Turn
      const scheduled = this._context.turnQueue.status(spawned.turnId)

      if (spawned.status !== 'queued' || scheduled) {
        // 已经开始或已经排队的原任务直接返回当前持久结果
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
        // 提交异常后若任务已经被执行器接管，仍以实际持久结果为准
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
        // 仅本次新建且未被接管的 queued 任务可由派生入口结算失败
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
    // 一次读取直接子线程及各自最新运行，避免逐线程查询主记录
    const records = await store.spawnEdges.listChildrenWithLatestTurn(parentThreadId)
    // 需要结果正文时才物化 Canonical 内容，状态查询避免额外读取
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
    // Turn 级派生边证明该运行的来源，单独存在的 Turn 不能冒充子任务
    const [turnEdge, turn] = await Promise.all([
      store.turnSpawnEdges.readByChildTurn(childTurnId),
      store.turns.read(childTurnId),
    ])

    if (!turnEdge || !turn)
      return

    // 线程级派生边与线程记录提供父线程归属和对外元信息
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
    // 展示标题优先采用线程当前标题，角色名只在对外结果中作为缺省值
    const title = thread.title
    // 中断事实来自原子任务 Turn，不借用父线程或其他运行的交互
    const interrupt = readThreadInterrupt(turn.interrupt)
    // 识别真正待处理的人机交互，供工具侧区分等待与普通中断
    const interaction = readThreadInteraction(interrupt)
    // 工具接口把待交互中断显示为 waiting，持久 Turn 状态仍保持 interrupted
    const status = turn.status === 'interrupted'
      && interaction?.status === 'pending'
      ? 'waiting'
      : turn.status
    // 父线程事件携带完整子任务状态，角色与执行时间均来自冻结事实
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
    // 从 Canonical 时间线定位最后一条助手消息及其内容片段
    const [messages, parts] = await Promise.all([
      store.canonical.list(threadId),
      store.canonical.listParts(threadId),
    ])
    // 只展示最后一条助手结果，用户描述和工具记录不作为任务总结
    const assistant = messages.findLast(message => message.role === 'assistant')

    if (!assistant)
      return ''

    // 重新物化选中消息的真实片段内容，避免仅返回存储引用
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
    // 先取消队列等待或通知已启动协程，保持调度与持久结算顺序一致
    const cancelledJob = this._context.turnQueue.cancel(childTurnId, 'cancelled')
    // 有活跃控制器时由原执行路径结算，没有时才直接结算持久记录
    const active = this._context.turns.get(childThreadId)

    if (active) {
      this._context.turns.interrupt(childThreadId, 'cancelled', childTurnId)
    }
    else {
      // 无控制器的 queued 或 waiting 子任务通过统一事务结算取消
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
      // 通知前重新读取完整子状态，避免广播取消前缓存的运行状态
      const child = await this._readByTurn(store, childTurnId, false)

      if (!child)
        return

      // 父线程接收子状态事件，归属由持久线程派生边确定
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
