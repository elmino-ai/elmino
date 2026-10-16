import type { Agent, AgentHooks, AgentSnapshot, InteractionResolution, StateResolution } from '@elmino/agent'
import type { Message } from '@elmino/llm'
import type {
  TurnContext,
  TurnInputMessage,
  TurnOutcome,
  TurnOutcomeStatus,
  TurnResult,
  TurnResumeInput,
  TurnRuntimeEventHandler,
  TurnServices,
} from '@elmino/loop'
import type { JsonValue, Promisable, SetFieldType, UnknownRecord } from '@elmino/shared'
import type {
  RuntimeStore,
  RuntimeStoreTx,
  RuntimeTurnRecord,
  SubagentRole,
  ThreadMessage,
  ThreadPart,
  ThreadStatus,
  ThreadTurnStatus,
} from '@elmino/store'
import type {
  RuntimeEvent,
  RuntimeEventType,
  ThreadExtensionState,
  ThreadInteractionInterrupt,
  ThreadInterrupt,
} from '@elmino/thread'
import type { HostServiceBinding } from '@elmino/tool'
import type { TurnInputPart } from '../turn/input'
import type { PreparedTurn, PreparedTurnStatus, ResolvedTurnRequest } from '../turn/types'
import type { TurnControl, TurnControlRegistry, TurnReservation } from './control'
import { resolveLoopInteraction } from '@elmino/loop'
import { createId, isPlainRecord } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import {
  appendCanonicalMessage,
  createRuntimeEvent,
  readThreadInteraction,
  readThreadInterrupt,
  runtimeRecordsToThreadSnapshot,
  settleTurnOutputTx,
  updateThreadExtensionStateTx,
} from '@elmino/thread'
import dayjs from 'dayjs'
import { createTrackedTurnModel } from './step'

/** -------------------- 类型 -------------------- */
/** Turn 准备阶段已经解析出的持久身份 */
interface TurnPreparationContext {
  /** 准备子智能体身份时一并读取的现有 Turn */
  turn?: RuntimeTurnRecord
  /** 当前 Turn 冻结的子智能体角色 */
  subagentRole: SubagentRole
  /** 根 Turn 启动时捕获的可用角色目录 */
  subagentRoles: SubagentRole[]
  /** 子线程 Turn 所属的直接父线程 ID */
  parentThreadId?: string
  /** 当前公共入口要求的 Turn 准备语义 */
  operation: 'start' | 'submit' | 'resume'
  /** 删除栅栏建立前取得的本次入口预留 */
  reservation: TurnReservation
  /** 当前 Turn 作用域内复用的 Runtime 与项目 Store */
  services: TurnServices
}

/** 单 Turn 执行期间由 Engine 装配的扩展行为 */
interface TurnExecutionHooks {
  /** 启动事务提交后确认接纳，不受后续执行结果影响 */
  onAccepted?: () => void
  /** 当前 Turn 由 Agent 注入的宿主服务 */
  hostServices: HostServiceBinding[]
  /** 取消信号触发时解析最终状态 */
  resolveAbortStatus?: () => 'cancelled' | 'interrupted'
  /** Engine 观察完运行事件后的扩展处理 */
  onRuntimeEvent?: (event: RuntimeEvent) => Promisable<void>
  /** 根 Turn 被取消时级联处理中断边界 */
  onRootInterrupted?: () => Promisable<void>
}

/** AgentEngine 统一结算 Turn 和 Thread 稳定状态的输入 */
interface SettleTurnInput {
  /** 孤立执行结算的纯所有权前提，变化时必须整笔事务回滚 */
  shouldSettle?: () => boolean
  /** 活跃 Turn 已冻结的事实存储 */
  store: RuntimeStore
  /** 线程 ID */
  threadId: string
  /** Turn ID */
  turnId: string
  /** 取消待交互运行时，必须在同一事务内匹配当前中断 */
  interruptId?: string
  /** 允许转换的起始状态 */
  from: ThreadTurnStatus[]
  /** Turn 终态或可恢复中断态 */
  status: Extract<
    ThreadTurnStatus,
    'completed' | 'failed' | 'cancelled' | 'interrupted'
  >
  /** Thread 稳定状态 */
  threadStatus: ThreadStatus
  /** 结束时间 */
  endedAt?: string
  /** 失败或取消原因 */
  errorMessage?: string
  /** 等待恢复的交互事实 */
  interrupt?: ThreadInterrupt
  /** 用户最后交互时间 */
  lastInteractionAt?: string
  /** 根 Turn 产生待查看结果后标记线程存在未读提醒 */
  markUnread?: boolean
  /** Turn 与 Thread 结算后必须在同一事务完成的附带清理 */
  onSettled?: (tx: RuntimeStoreTx, endedAt: string) => Promise<void>
  /** 当前执行切片的扩展，缺省时使用 Agent 定义 */
  hooks?: AgentHooks
}

/** Engine 启动事务生成的恢复效果 */
interface StartedTurn {
  /** 恢复时追加并需要广播的用户消息 */
  messages: ThreadMessage[]
  /** 恢复时追加给 Provider 的用户消息 */
  providerMessages: TurnInputMessage[]
  /** 恢复时追加给 Provider 的隐藏消息 */
  hiddenMessages: Message[]
  /** 已由 Engine 校验的 Loop 恢复输入 */
  resume?: TurnResumeInput
  /** Interaction 选择取消时的原子结算时间 */
  cancelledAt?: string
}

/** Engine 已完成命名空间校验的 Interaction 效果 */
interface ResolvedInteractionEffect extends InteractionResolution {
  /** 交给 Loop 的归一化 JSON 响应 */
  response: JsonValue
  /** 缺省补齐后的隐藏消息 */
  hiddenMessages: Message[]
}

/** Engine 可持久化的单次 Turn 终态，额外接受控制面取消状态 */
type TurnSettlementOutcome = SetFieldType<
  TurnOutcome,
  'status',
  TurnOutcomeStatus | 'cancelled'
>

/** Loop 正常退出时应在持久化结算后发布的终态事件 */
const TERMINAL_TURN_EVENT_TYPES = new Set<RuntimeEventType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.cancelled',
])

/** -------------------- 核心类 -------------------- */
/**
 * 提供可复用的 Agent Turn 准备、执行与结算能力
 */
export class TurnExecutor {
  /**
   * 创建可复用的 Turn 准备与执行服务
   */
  public static create(
    agent: Agent,
    turns: TurnControlRegistry,
  ) {
    return new TurnExecutor(agent, turns)
  }

  /**
   * 保存 Agent 调用入口和进程态运行控制
   */
  private constructor(
    private readonly _agent: Agent,
    private readonly _turns: TurnControlRegistry,
  ) {}

  /** -------------------- 核心方法 -------------------- */
  /**
   * 事务化创建 Turn 和输入消息，并冻结本次执行参数
   */
  public async prepare(
    options: ResolvedTurnRequest,
    context: TurnPreparationContext,
  ): Promise<PreparedTurn> {
    // 本次请求的输入、位置和执行策略已由上层入口冻结
    const {
      approvalMode: _approvalMode,
      hiddenMessages: _hiddenMessages,
      input,
      location,
      model,
      onRuntimeEvent,
      resume,
      signal,
      subagentMode: _subagentMode,
      threadId,
      turnId,
    } = options
    // 准备阶段只使用当前作用域注入的运行服务
    const { services } = context
    // 所有线程、Turn 与消息写入均落在这份事实存储
    const { store } = services
    // 入口操作与父子身份来自协调器，恢复角色不能重新选择
    const { operation, subagentRole: _subagentRole, subagentRoles: _subagentRoles, parentThreadId } = context
    // 既有 Turn 是恢复和排队重提交时的冻结事实来源
    const existingTurn = context.turn
    // 只保存可持久化模型配置，不把适配器或凭据写入运行记录
    const modelConfig = model.config
    // 收集本次新建的用户消息，提交事务后再发布消息通知
    const messages: TurnInputMessage[] = []
    // 宿主隐藏输入只参与本次执行上下文，不作为普通用户消息展示
    const hiddenMessages = _hiddenMessages ?? []

    if (operation === 'start' && existingTurn)
      throw new Error(`Turn 已存在，不能再次启动: ${turnId}`)
    if (operation === 'start' && parentThreadId)
      throw new Error('子线程暂不支持创建新的 Turn')
    if (operation === 'resume' && existingTurn?.status !== 'interrupted')
      throw new Error(`Turn 不是可恢复状态: ${turnId}`)
    if (operation === 'resume' && !resume)
      throw new Error('恢复 Turn 缺少 Interaction 响应')
    if (operation !== 'resume' && resume)
      throw new Error('新 Turn 不能携带 Interaction 响应')
    if (
      operation === 'submit'
      && existingTurn
      && existingTurn.status !== 'queued'
      && existingTurn.status !== 'running'
    ) {
      throw new Error(`Turn 不是可提交状态: ${turnId}`)
    }

    // 工作区身份随线程元数据保存，用于后续执行归属校验
    const { workspaceId } = location
    // 根任务在准备阶段取得控制权，子任务等待进入并发槽后再取得
    const control = !parentThreadId
      ? this._turns.start(context.reservation, { agentId: this._agent.id, store })
      : undefined

    try {
      // 线程归属、Turn 创建和用户输入必须在同一事务内确认
      const { agentSnapshot, turn: preparedTurn } = await store.transaction(async (tx) => {
        // 事务内重读线程，避免使用准备前已经变化的目录或归属
        const currentThread = await tx.threads.read(threadId)
        // 事务内重读 Turn，防止重复创建或覆盖并发恢复后的状态
        const currentTurn = await tx.turns.read(turnId)

        if (currentThread && currentThread.agentId !== this._agent.id)
          throw new Error('线程不属于当前 Agent')
        if (currentThread && (
          currentThread.dir !== location.dir
          || (currentThread.metadata.workspaceId && currentThread.metadata.workspaceId !== workspaceId)
        )) {
          throw new Error('线程的工作区或执行目录与当前请求不一致')
        }
        if (currentTurn && (
          currentTurn.threadId !== threadId || currentTurn.agentSnapshot.id !== this._agent.id
        )) {
          throw new Error('Turn 不属于当前线程或 Agent')
        }
        if (operation === 'start' && currentTurn)
          throw new Error(`Turn 已存在，不能再次启动: ${turnId}`)
        if (existingTurn && currentTurn?.status !== existingTurn.status)
          throw new Error('Turn 状态已经变化，请刷新后重试')
        // 首次创建 Turn 的时间在事务内统一生成
        const now = dayjs().toISOString()
        // 恢复沿用原 Agent 快照，新运行才捕获当前定义
        const agentSnapshot = existingTurn
          ? existingTurn.agentSnapshot as unknown as AgentSnapshot
          : {
              id: this._agent.id,
              systemPrompt: this._agent.systemPrompt,
            }

        // 线程归属使用本轮冻结的 Agent 身份
        const { id: agentId } = agentSnapshot
        // 审批权限优先沿用原 Turn，其次请求与线程默认值，恢复不得提权
        const approvalMode = existingTurn?.approvalMode
          ?? _approvalMode
          ?? currentThread?.settings.approvalMode
          ?? DEFAULT_THREAD_SETTINGS.approvalMode
        // 子智能体模式同样按冻结 Turn、显式请求和线程默认值确定
        const subagentMode = existingTurn?.subagentMode
          ?? _subagentMode
          ?? currentThread?.settings.subagentMode
          ?? DEFAULT_THREAD_SETTINGS.subagentMode

        await tx.threads.upsert({
          id: threadId,
          agentId,
          dir: currentThread?.dir ?? location.dir,
          status: currentThread?.status ?? 'idle',
          metadata: {
            ...currentThread?.metadata,
            workspaceId,
          },
          settings: existingTurn
            ? undefined
            : {
                modelId: model.config.id,
                reasoningLevel: model.config.reasoning?.level,
                approvalMode,
                subagentMode,
                pluginSettings: currentThread?.settings.pluginSettings ?? {},
              },
          state: currentThread
            ? undefined
            : {
                contextProjection: {},
                extensionState: {},
              },
        })

        // 恢复和重提交复用原 Turn，新任务才建立 queued 运行记录
        const turn = existingTurn
          ?? await tx.turns.create({
            id: turnId,
            threadId,
            status: 'queued',
            modelConfig: { ...modelConfig },
            subagentRole: _subagentRole,
            subagentRoles: _subagentRoles,
            agentSnapshot: { ...agentSnapshot },
            approvalMode,
            subagentMode,
            createdAt: now,
          })

        if (!existingTurn && input?.length) {
          messages.push(await this._createUserMessage(
            tx,
            threadId,
            turnId,
            input,
            providerMessage(input),
          ))
        }

        return { agentSnapshot, turn }
      })

      // 只发布本次事务新建的用户消息，不重新广播已有历史
      for (const { transcript: message } of messages) {
        if (!message)
          continue

        // 持久消息身份用于让事件与线程消息投影对应
        const messageId = message.id
        // 首个片段作为消息更新的局部锚点，身份来自已落库记录
        const partId = message.parts[0]!.id
        // 通知携带同一份持久消息投影，不再重新组装正文
        const payload = { message }

        try {
          await onRuntimeEvent?.(createRuntimeEvent({
            type: 'message.updated',
            threadId,
            turnId,
            messageId,
            partId,
            payload,
          }))
        }
        catch (error) {
          // 消息已经持久化，通知失败不能让提交被判为失败
          console.warn('用户消息事件发布失败', error)
        }
      }

      // 后续 Loop 使用事务确认的模式和角色，不继续读取请求侧默认值
      const { approvalMode, status: _turnStatus, subagentMode, subagentRole, subagentRoles } = preparedTurn
      // 准备结果只允许 queued、running 或 interrupted，具体转换由执行入口控制
      const turnStatus = _turnStatus as PreparedTurnStatus

      return {
        model,
        threadId,
        turnId,
        location,
        signal,
        onRuntimeEvent,
        messages,
        hiddenMessages,
        tools: this._agent.tools,
        hooks: this._agent.hooks,
        resume,
        subagentRole,
        subagentRoles,
        control,
        parentThreadId,
        turnStatus,
        agentSnapshot,
        approvalMode,
        subagentMode,
        services,
      }
    }
    catch (error) {
      if (control)
        this._turns.complete(threadId, turnId)

      throw error
    }
  }

  /**
   * 注册控制器并执行一次已经准备完成的 Turn
   */
  public async run(
    options: PreparedTurn,
    hooks: TurnExecutionHooks,
  ) {
    // 当前切片的冻结身份与运行服务在整个执行期间保持一致
    const { agentSnapshot, turnId, services, threadId } = options
    // 根任务沿用准备时控制器，排队子任务此时才正式取得控制权
    const control = options.control ?? this._turns.start(
      { threadId, turnId },
      { agentId: agentSnapshot.id, store: services.store },
    )
    // 暂存 Loop 终态通知，等持久结算成功后再发布唯一权威终态
    const terminalEvents: RuntimeEvent[] = []

    /** 将运行事件同步到进程投影和宿主出口 */
    const forwardEvent = async (event: RuntimeEvent) => {
      this._turns.applyEvent(event)
      await Promise.allSettled([
        Promise.resolve().then(() => hooks.onRuntimeEvent?.(event)),
        Promise.resolve().then(() => options.onRuntimeEvent?.(event)),
      ])
    }

    /** 将调用方取消信号汇入 Engine 统一控制器 */
    const abortTurn = () => control.controller.abort(options.signal?.reason)
    /** 在 Provider 调用边界前后拒绝已经中断的 Turn */
    const ensureActive = () => {
      if (!control.controller.signal.aborted)
        return

      // 取消原因来自统一控制器，外部信号和用户中断共用这条失败路径
      const reason = control.controller.signal.reason

      throw reason instanceof Error
        ? reason
        : new Error(String(reason ?? 'interrupted'))
    }

    if (options.signal?.aborted)
      abortTurn()
    else
      options.signal?.addEventListener('abort', abortTurn, { once: true })

    try {
      // 本轮所有持久写入共用注入的事实存储
      const { store } = services

      // 启动事务校验恢复交互并生成需要追加到上下文的效果
      const started = await this._start(options, store)

      hooks.onAccepted?.()
      // 保留 Loop 返回结果，后续异常结算可能仍需使用其结构化中断
      let result: TurnResult | undefined

      if (started.cancelledAt) {
        // 交互选择直接取消时，通知复用启动事务已固定的取消时间
        const createdAt = started.cancelledAt

        await forwardEvent(createRuntimeEvent({
          type: 'turn.cancelled',
          threadId,
          turnId,
          createdAt,
          payload: {
            stopReason: 'interaction_cancelled',
            threadStatus: 'completed',
          },
        }))

        return
      }

      try {
        ensureActive()

        // 恢复时新产生的用户输入需在进入 Loop 前同步到观察者
        for (const message of started.messages) {
          // 消息首片段作为本次消息更新的事件锚点
          const firstPart = message.parts[0]

          await forwardEvent(createRuntimeEvent({
            type: 'message.updated',
            threadId: options.threadId,
            turnId: options.turnId,
            messageId: message.id,
            partId: firstPart?.id,
            payload: { message },
          }))
        }

        // 包装原模型以统一记录每个 Provider Step 的运行事实
        const model = createTrackedTurnModel({
          model: options.model,
          turnId,
          threadId,
          store,
          onRuntimeEvent: forwardEvent,
        })
        // 前序模型与线程启动信息来自当前持久时间线，而不是外部缓存
        const { previousModel, start } = await this._prepareTurn(options)
        // Loop 只接收本次冻结上下文与服务，不承担 Engine 调度或资源所有权
        const loopContext: TurnContext = {
          model,
          approvalMode: options.approvalMode,
          subagentMode: options.subagentMode,
          subagentRole: options.subagentRole,
          subagentRoles: options.subagentRoles,
          parentThreadId: options.parentThreadId,
          threadId,
          turnId,
          location: options.location,
          signal: control.controller.signal,
          agentId: agentSnapshot.id,
          systemPrompt: [{ type: 'text', text: agentSnapshot.systemPrompt }],
          previousModel,
          hostServices: hooks.hostServices,
          tools: options.tools,
          hooks: options.hooks,
          services,
          start,
          thread: this._agent.thread,
          input: {
            messages: [
              ...options.messages,
              ...started.providerMessages,
            ],
            hiddenMessages: [
              ...options.hiddenMessages,
              ...started.hiddenMessages,
            ],
            resume: started.resume,
          },
          steering: {
            afterStep: status => this._turns.afterStep(control, status),
          },
          onRuntimeEvent: async (event) => {
            // Loop 终态必须等 Engine 先固定数据库事实，其他流式事件继续实时转发
            if (TERMINAL_TURN_EVENT_TYPES.has(event.type)) {
              terminalEvents.push(event)
              return
            }

            await forwardEvent(event)
          },
        }

        ensureActive()
        result = await this._agent.loop.invoke(loopContext)
        ensureActive()
      }
      catch (error) {
        // 错误发生时读取统一控制器，区分用户中断与普通执行失败
        const aborted = control.controller.signal.aborted
        // 保留子任务级联失败，但仍先结算根 Turn 自身的权威终态
        let cascadeError: unknown

        if (aborted && !options.parentThreadId) {
          try {
            await hooks.onRootInterrupted?.()
          }
          catch (childError) {
            // 子任务级联失败不能阻止父 Turn 先固定自身终态
            cascadeError = childError
          }
        }

        // 显式子任务取消可投影为 cancelled，其他中止默认 interrupted
        const status = aborted
          ? hooks.resolveAbortStatus?.() ?? 'interrupted'
          : 'failed'
        // 错误说明写入终态事实，供重启后查询与界面展示
        const errorMessage = error instanceof Error ? error.message : String(error)
        // 若 Loop 已产生结构化交互中断，异常结算仍保留它的恢复身份
        const interruptedOutcome = result?.outcome
        // 缺少结构化中断时补齐系统中断，以统一持久与通知语义
        const outcome = this._normalizeOutcome(options, {
          status,
          interrupt: interruptedOutcome?.interrupt,
          errorMessage,
        })

        // 只有成功取得持久结算时间，才允许发布对应终态事件
        const endedAt = await this._settle(options, outcome, control)

        if (endedAt) {
          await this._forwardTerminalEvent(
            options,
            outcome,
            endedAt,
            [],
            forwardEvent,
          )
        }

        if (cascadeError) {
          throw new AggregateError(
            [error, cascadeError],
            '根 Turn 中断时级联取消子任务失败',
          )
        }

        throw error
      }

      // 正常返回同样先补齐中断事实，再进入统一结算路径
      const outcome = this._normalizeOutcome(options, result!.outcome)
      // 事务返回的终态时间是后续事件的权威时间来源
      const endedAt = await this._settle(options, outcome, control)

      if (endedAt) {
        await this._forwardTerminalEvent(
          options,
          outcome,
          endedAt,
          terminalEvents,
          forwardEvent,
        )
      }

      return result!.response
    }
    finally {
      options.signal?.removeEventListener('abort', abortTurn)
      // 删除线程会等待此控制权释放，因此必须放在全部结算写入之后
      this._turns.complete(threadId, turnId)
    }
  }

  /**
   * 原子结算 Turn 与所属 Thread，并返回已经持久化的结束时间
   */
  public settleTurn(input: SettleTurnInput) {
    // 使用固定异常身份区分所有权变更回滚与真实存储故障
    const ownershipChanged = new Error('Turn 结算期间已被执行入口接纳')
    /** 读取和写入等待后重新检查进程所有权，避免孤立恢复覆盖正在装配的任务 */
    const assertOwnership = () => {
      if (input.shouldSettle && !input.shouldSettle())
        throw ownershipChanged
    }

    return input.store.transaction(async (tx) => {
      // 事务内重读运行归属，避免结算已经删除或迁移的记录
      const current = await tx.turns.read(input.turnId)

      if (current?.threadId !== input.threadId)
        return

      if (input.interruptId) {
        // 取消审批必须命中仍待处理的交互，不能只匹配 interrupted 状态
        const interrupt = readThreadInteraction(readThreadInterrupt(current.interrupt))
        // 最新 Turn 约束防止旧审批取消覆盖线程后来产生的运行
        const latest = await tx.turns.readLatest(input.threadId)

        if (
          current.status !== 'interrupted'
          || latest?.id !== input.turnId
          || interrupt?.status !== 'pending'
          || interrupt.turnId !== input.turnId
          || interrupt.id !== input.interruptId
        ) {
          return
        }
      }
      // 线程与 Turn 的 Agent 归属必须在同一个结算事务里成立
      const thread = await tx.threads.read(input.threadId)

      if (thread?.agentId !== this._agent.id || current.agentSnapshot.id !== this._agent.id)
        return
      // 显式结束时间或当前时间作为本次结算的初始候选
      const requestedAt = dayjs(input.endedAt ?? undefined)
      // 线程元信息可能先推进更新时间，结算需要避免时间倒退
      const currentUpdatedAt = thread ? dayjs(thread.updatedAt) : undefined
      // 元信息事务可能先推进 Thread 时间；统一结算时间必须继续单调递增，避免新事实被 SDK 当作旧快照
      const endedAt = currentUpdatedAt && !requestedAt.isAfter(currentUpdatedAt)
        ? currentUpdatedAt.add(1, 'millisecond').toISOString()
        : requestedAt.toISOString()

      assertOwnership()
      // 条件转换确保只有预期起始状态可以被本次结算消费
      const settled = await tx.turns.transition(input.turnId, input.from, {
        status: input.status,
        endedAt,
        errorMessage: input.errorMessage,
        interrupt: input.interrupt ? { ...input.interrupt } : undefined,
      })

      if (!settled)
        return

      assertOwnership()

      await tx.threads.upsert({
        id: input.threadId,
        status: input.threadStatus,
        unreadAt: input.markUnread ? endedAt : undefined,
        lastInteractionAt: input.lastInteractionAt,
        updatedAt: endedAt,
      })
      // 等待交互时保留工具和扩展状态，以便原 Turn 后续恢复
      const waitsForInteraction = input.status === 'interrupted'
        && input.interrupt?.kind === 'interaction'

      if (!waitsForInteraction) {
        await this._settleState(
          tx,
          input.threadId,
          input.status,
          input.hooks ?? this._agent.hooks,
        )
      }
      if (input.status !== 'completed' && !waitsForInteraction) {
        await settleTurnOutputTx(
          tx,
          input.threadId,
          input.turnId,
          input.status === 'failed' ? 'failed' : 'interrupted',
          input.errorMessage ?? input.interrupt?.reason ?? 'Turn 在输出收口前结束',
          endedAt,
        )
      }
      await input.onSettled?.(tx, endedAt)

      assertOwnership()

      return endedAt
    }).catch((error: unknown) => {
      if (error === ownershipChanged)
        return undefined
      throw error
    })
  }

  /**
   * 把纯文本引导持久化到准确的活跃 Turn
   */
  public steer(input: {
    /** 线程 ID */
    threadId: string
    /** 预期活跃 Turn ID */
    turnId: string
    /** 用户输入文本 */
    text: string
    /** 当前项目事实存储 */
    store: RuntimeStore
    /** 结构化运行事件出口 */
    onRuntimeEvent?: TurnRuntimeEventHandler
  }) {
    // 引导只面向准确的存储和执行身份，事件出口随调用一起捕获
    const { onRuntimeEvent, store, text, threadId, turnId } = input

    return this._turns.steer(threadId, turnId, async () => {
      // 引导以普通文本输入形式追加，不为它创建独立 Turn
      const parts: TurnInputPart[] = [{ type: 'text', text }]
      // 用户消息和最后交互时间在同一事务内持久化
      const message = await store.transaction(async (tx) => {
        // 消息同时写入展示记录和模型上下文，避免引导只在一侧可见
        const message = await this._createUserMessage(
          tx,
          threadId,
          turnId,
          parts,
          providerMessage(parts),
        )

        await tx.threads.upsert({
          id: threadId,
          lastInteractionAt: message.transcript!.createdAt,
        })

        return message
      })
      // 事务返回的展示消息用于进程投影与外部事件通知
      const transcript = message.transcript!
      // 首片段用于定位这次新增的引导内容
      const firstPart = transcript.parts[0]
      // 消息身份沿用持久记录，事件不再生成另一份消息
      const messageId = transcript.id
      // 片段身份在存在正文时提供，保持事件定位与消息结构一致
      const partId = firstPart?.id
      // 通知中的完整消息已持久化，观察者可以直接替换对应投影
      const event = createRuntimeEvent({
        type: 'message.updated',
        threadId,
        turnId,
        messageId,
        partId,
        payload: { message: transcript },
      })

      this._turns.applyEvent(event)
      try {
        await onRuntimeEvent?.(event)
      }
      catch (error) {
        // 引导消息已经持久化，通知失败不能让发送被判为失败
        console.warn('引导消息事件发布失败', error)
      }

      return message
    })
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 从同一执行切片冻结 Loop 启动事实
   */
  private async _prepareTurn(
    options: PreparedTurn,
  ) {
    // 从本次执行注入的服务读取线程启动事实
    const { store } = options.services
    // 线程元信息和完整 Turn 时间线共同决定 Loop 的启动语义
    const [thread, turns] = await Promise.all([
      store.threads.read(options.threadId),
      store.turns.list(options.threadId),
    ])
    // 当前 Turn 在时间线中的位置用于查找前一轮模型配置
    const index = turns.findIndex(turn => turn.id === options.turnId)
    // 首轮没有前序模型，后续轮次使用紧邻前一轮的冻结配置
    const previousTurn = index > 0 ? turns[index - 1] : undefined
    // 将持久线程与 Turn 转换为统一快照供 Loop 和 Hooks 消费
    const threadSnapshot = thread
      ? runtimeRecordsToThreadSnapshot(thread, turns, options.location)
      : undefined

    return {
      previousModel: previousTurn?.modelConfig,
      start: {
        threadSnapshot,
        // AgentEngine 会先建 Thread 和当前 Turn；没有历史 Turn 的首次提交仍然属于 thread.start
        startsThread: !options.resume && (
          !thread
          || turns.every(turn => turn.id === options.turnId)
        ),
      },
    }
  }

  /**
   * 在获得执行权后把 queued 或 interrupted Turn 原子切换为 running
   */
  private _start(options: PreparedTurn, store: RuntimeStore) {
    return store.transaction(async (tx) => {
      // 启动事务重读原 Turn，恢复请求不能消费已变化的运行状态
      const current = await tx.turns.read(options.turnId)
      // 线程必须仍存在，才能把运行状态推进为 running
      const thread = await tx.threads.read(options.threadId)

      if (
        !thread
        || current?.threadId !== options.threadId
        || current.status !== options.turnStatus
      ) {
        throw new Error('Turn 状态已经变化，请刷新后重试')
      }

      // 集中收集恢复产生的可见输入、隐藏输入和 Loop 恢复命令
      const started: StartedTurn = {
        messages: [],
        providerMessages: [],
        hiddenMessages: [],
      }

      if (current.status === 'interrupted') {
        // 恢复决策只来自当前请求，不读取其他轮次或最新交互
        const request = options.resume
        // 持久交互快照提供本次恢复必须匹配的准确身份
        const interrupt = readThreadInteraction(
          readThreadInterrupt(current.interrupt),
        )

        if (
          !request
          || !interrupt
          || interrupt.status !== 'pending'
          || interrupt.turnId !== options.turnId
          || interrupt.id !== request.interruptId
        ) {
          throw new Error('Interaction 已过期或不属于当前 Turn')
        }

        // 内置审批或宿主交互先归一化为明确的恢复效果
        const resolution = await this._resolveInteraction(
          tx,
          options,
          interrupt,
          request.response,
        )

        await this._applyState(tx, options.threadId, resolution.state)

        if (resolution.action === 'cancel') {
          // 交互决定终止运行时，在启动事务内生成唯一取消时间
          const cancelledAt = dayjs().toISOString()
          // 只消费仍 interrupted 的原 Turn，避免重复处理相同交互
          const settled = await tx.turns.transition(options.turnId, ['interrupted'], {
            status: 'cancelled',
            endedAt: cancelledAt,
            interrupt: undefined,
          })

          if (!settled)
            throw new Error('Interaction 已被其他请求处理')

          await settleTurnOutputTx(
            tx,
            options.threadId,
            options.turnId,
            'interrupted',
            'Interaction 已取消',
            cancelledAt,
          )
          await tx.threads.upsert({
            id: options.threadId,
            status: 'completed',
            updatedAt: cancelledAt,
          })
          await this._settleState(
            tx,
            options.threadId,
            'cancelled',
            options.hooks,
          )
          started.cancelledAt = cancelledAt
          return started
        }

        if (resolution.input) {
          // 交互产生的可见回复以用户文本追加到原 Turn
          const input: TurnInputPart[] = [{
            type: 'text',
            text: resolution.input,
          }]
          // 同一回复同时投影为 Provider 输入，保持展示与上下文一致
          const provider = providerMessage(input)
          // 恢复输入在同一事务中写入可重放的消息记录
          const inputMessage = await this._createUserMessage(
            tx,
            options.threadId,
            options.turnId,
            input,
            provider,
          )

          started.messages.push(inputMessage.transcript)
          started.providerMessages.push(inputMessage)
        }

        started.hiddenMessages.push(...resolution.hiddenMessages)
        started.resume = {
          interrupt,
          response: resolution.response,
          toolResult: resolution.toolResult,
          part: resolution.part,
        }
      }
      else if (options.resume) {
        throw new Error('当前 Turn 不接受 Interaction 响应')
      }

      // 完成交互消费后才把原 Turn 切回 running 并清除旧中断
      const transitioned = await tx.turns.transition(
        options.turnId,
        [current.status],
        {
          status: 'running',
          errorMessage: undefined,
          interrupt: undefined,
        },
      )

      if (!transitioned)
        throw new Error('Turn 状态已经变化，请刷新后重试')

      await tx.threads.upsert({
        id: options.threadId,
        status: 'running',
      })

      return started
    })
  }

  /**
   * 在启动事务内解析内置或宿主 Interaction
   */
  private async _resolveInteraction(
    store: RuntimeStoreTx,
    options: PreparedTurn,
    interrupt: ThreadInteractionInterrupt,
    response: JsonValue,
  ): Promise<ResolvedInteractionEffect> {
    if (!interrupt.ownerId && interrupt.interaction === 'tool_approval') {
      // 内置工具审批先校验并归一化为 Loop 接受的决策结构
      const normalized = resolveLoopInteraction(interrupt, response)

      if (normalized === undefined)
        throw new Error(`未知或无效的 Loop Interaction: ${interrupt.interaction}`)
      return { action: 'resume', response: normalized, hiddenMessages: [] }
    }

    // 宿主自定义交互只读取当前线程的持久扩展状态
    const thread = await store.threads.read(options.threadId)
    // 提取实际扩展命名空间，避免把线程其他字段交给状态处理器
    const state = this._readState(thread?.state)
    // 宿主 Hook 必须明确返回恢复或取消效果，否则交互不能被消费
    const resolution = await options.hooks?.resolveInteraction?.({ interrupt, response, state })

    if (!resolution)
      throw new Error(`未知或无效的 Interaction: ${interrupt.interaction}`)

    return { ...resolution, hiddenMessages: resolution.hiddenMessages ?? [] }
  }

  /**
   * 在当前事务应用各扩展命名空间的结算动作
   */
  private async _applyState(
    store: RuntimeStoreTx,
    threadId: string,
    resolutions?: Record<string, StateResolution>,
  ) {
    // 逐个扩展命名空间应用纯状态变更，不影响其他扩展的事实
    for (const [key, resolution] of Object.entries(resolutions ?? {})) {
      if (resolution.type === 'keep')
        continue

      await updateThreadExtensionStateTx(
        store,
        threadId,
        key,
        resolution.type === 'replace' ? resolution.value : undefined,
      )
    }
  }

  /**
   * 在 Turn 稳定结算事务内运行宿主的纯状态 reducer
   */
  private async _settleState(
    store: RuntimeStoreTx,
    threadId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    hooks?: AgentHooks,
  ) {
    if (!hooks?.settleState)
      return

    // 结算 Hook 基于事务内最新线程状态计算，不能使用运行开始时的旧快照
    const thread = await store.threads.read(threadId)
    // 只把扩展命名空间交给宿主纯状态 reducer
    const state = this._readState(thread?.state)
    // 宿主返回各命名空间的保留、替换或删除动作，再由事务统一应用
    const resolutions = await hooks.settleState({ status, state })

    await this._applyState(store, threadId, resolutions)
  }

  /**
   * 从线程的持久事实读取实际扩展命名空间
   */
  private _readState(state?: UnknownRecord): ThreadExtensionState {
    return isPlainRecord(state?.extensionState)
      ? state.extensionState as ThreadExtensionState
      : {}
  }

  /**
   * 在当前 Store 事务中追加一条结构化用户消息
   */
  private async _createUserMessage(
    store: RuntimeStoreTx,
    threadId: string,
    turnId: string,
    input: TurnInputPart[],
    message: Message,
  ) {
    // 用户消息与它的所有展示片段共用创建时间
    const createdAt = dayjs().toISOString()
    // 展示消息使用独立消息身份，随后与原 Turn 关联
    const messageId = createId('msg')
    // 用户输入按顺序投影为展示消息，原始内容仍用于 Canonical 上下文
    const transcript: ThreadMessage = {
      id: messageId,
      threadId,
      turnId,
      role: 'user',
      kind: 'normal',
      status: 'completed',
      parts: input.map((part, index) => {
        // 展示片段序号从一开始，保留输入数组的原始顺序
        const seq = index + 1
        return threadInputPart(part, {
          messageId,
          threadId,
          turnId,
          seq,
          createdAt,
        })
      }),
      createdAt,
      updatedAt: createdAt,
      metadata: {},
    }
    await store.transcript.upsert(transcript)
    // Canonical 记录提供 Provider 可重放上下文及其顺序锚点
    const canonical = await appendCanonicalMessage(store, {
      threadId,
      turnId,
      message,
    })

    return {
      message,
      transcript,
      canonicalSeq: canonical.seq,
    }
  }

  /**
   * 只结算仍由 Engine 持有的 running Turn，避免覆盖取消路径的终态
   */
  private async _settle(
    options: PreparedTurn,
    outcome: TurnSettlementOutcome,
    control: TurnControl,
  ) {
    if (!await this._turns.beginSettlement(control))
      return

    return this.settleTurn({
      store: options.services.store,
      threadId: options.threadId,
      turnId: options.turnId,
      from: ['running'],
      status: outcome.status,
      threadStatus: outcome.status === 'cancelled'
        ? 'interrupted'
        : outcome.status,
      errorMessage: outcome.errorMessage,
      interrupt: outcome.interrupt,
      markUnread: !options.parentThreadId && shouldMarkThreadUnread(outcome),
      hooks: options.hooks,
    })
  }

  /**
   * 在 Turn 持久终态已固定后发布唯一终态事件
   */
  private _forwardTerminalEvent(
    options: PreparedTurn,
    outcome: TurnSettlementOutcome,
    endedAt: string,
    events: RuntimeEvent[],
    forward: (event: RuntimeEvent) => Promise<void>,
  ) {
    // 权威 outcome 决定终态事件类型，不能沿用已失效的 Loop 临时状态
    const eventType = ({
      cancelled: 'turn.cancelled',
      completed: 'turn.completed',
      failed: 'turn.failed',
      interrupted: 'turn.interrupted',
    } as const)[outcome.status]
    // 复用最后一条同类型 Loop 事件中的详细信息
    const event = events.findLast(item => item.type === eventType)
    // 中断事件的恢复身份必须替换成最终持久化的那一份
    const canonicalEvent = event && outcome.status === 'interrupted'
      ? {
          ...event,
          interruptId: outcome.interrupt?.id,
          payload: outcome.interrupt,
        }
      : event

    // 清理器也属于 Turn 生命周期；最终 outcome 可能不同于 Loop 退出前生成的临时终态
    const terminalEvent = canonicalEvent
      ? { ...canonicalEvent, createdAt: endedAt }
      : createRuntimeEvent({
          type: eventType,
          threadId: options.threadId,
          turnId: options.turnId,
          interruptId: outcome.interrupt?.id,
          createdAt: endedAt,
          payload: outcome.interrupt ?? {
            message: outcome.errorMessage,
            reason: outcome.errorMessage,
            ...(outcome.status === 'cancelled'
              ? { threadStatus: 'interrupted' }
              : {}),
          },
        })

    if (options.parentThreadId || !shouldMarkThreadUnread(outcome))
      return forward(terminalEvent)

    // 保留原终态载荷，再为根任务附上同一次结算的未读时间
    const payload = terminalEvent.payload

    // 根 Turn 待查看终态直接携带结算事务写入的同一未读时间，避免列表校准失败时丢失实时投影
    return forward({
      ...terminalEvent,
      payload: {
        ...(payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload
          : {}),
        unreadAt: endedAt,
      },
    })
  }

  /**
   * 为缺少结构化事实的系统中断补齐唯一可持久化对象
   */
  private _normalizeOutcome(
    options: PreparedTurn,
    outcome: TurnSettlementOutcome,
  ): TurnSettlementOutcome {
    if (outcome.status !== 'interrupted' || outcome.interrupt)
      return outcome

    return {
      ...outcome,
      interrupt: {
        id: createId('interrupt'),
        kind: 'system',
        status: 'pending',
        turnId: options.turnId,
        reason: outcome.errorMessage ?? '运行被中断',
        createdAt: dayjs().toISOString(),
        resumableWith: ['message'],
      },
    }
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断 Turn 终态是否属于待查看结果
 */
function shouldMarkThreadUnread(outcome: TurnSettlementOutcome) {
  return outcome.status === 'completed'
    || outcome.status === 'failed'
    || (
      outcome.status === 'interrupted'
      && outcome.interrupt?.kind === 'interaction'
    )
}

/**
 * 将结构化输入转换成完成态 transcript part
 */
function threadInputPart(
  part: TurnInputPart,
  input: {
    messageId: string
    threadId: string
    turnId: string
    seq: number
    createdAt: string
  },
): ThreadPart {
  // 所有输入片段共用归属、顺序与时间，具体内容按类型追加
  const base = {
    id: createId('part'),
    ...input,
    status: 'completed' as const,
    updatedAt: input.createdAt,
  }

  if (part.type === 'text') {
    return {
      ...base,
      type: 'text',
      text: part.text,
    }
  }

  if (part.type === 'mention') {
    // 移除输入判别字段后复用引用信息，输出片段单独声明展示类型
    const { type: _, ...mention } = part

    return {
      ...base,
      type: 'mention',
      ...mention,
    }
  }

  if (part.type === 'image') {
    return {
      ...base,
      type: 'image',
      name: part.name,
      mime: part.mime,
      url: `data:${part.mime};base64,${part.data}`,
    }
  }

  return {
    ...base,
    type: 'document',
    name: part.name,
    extension: part.extension,
    artifactId: part.artifactId,
  }
}

/**
 * 将结构化输入转换成标准 Provider 用户消息
 */
function providerMessage(input: TurnInputPart[]): Message {
  return {
    role: 'user',
    parts: input.map((part) => {
      if (part.type === 'text')
        return { type: 'text', text: part.text }

      if (part.type === 'mention')
        return { type: 'text', text: part.label }

      if (part.type === 'document')
        return { type: 'text', text: part.modelText }

      return {
        type: 'image',
        mime: part.mime,
        data: part.data,
      }
    }),
  }
}
