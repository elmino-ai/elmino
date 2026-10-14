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
import type { TurnInputPart } from '../turn/input.js'
import type { PreparedTurn, PreparedTurnStatus, ResolvedTurnRequest } from '../turn/types.js'
import type { TurnControl, TurnControlRegistry, TurnReservation } from './control.js'
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
import { createTrackedTurnModel } from './step.js'

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
    const { services } = context
    const { store } = services
    const { operation, subagentRole: _subagentRole, subagentRoles: _subagentRoles, parentThreadId } = context
    const existingTurn = context.turn
    const modelConfig = model.config
    const messages: TurnInputMessage[] = []
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

    const { workspaceId } = location
    const control = !parentThreadId
      ? this._turns.start(context.reservation, { agentId: this._agent.id, store })
      : undefined

    try {
      const { agentSnapshot, turn: preparedTurn } = await store.transaction(async (tx) => {
        const currentThread = await tx.threads.read(threadId)
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
        const now = dayjs().toISOString()
        const agentSnapshot = existingTurn
          ? existingTurn.agentSnapshot as unknown as AgentSnapshot
          : {
              id: this._agent.id,
              systemPrompt: this._agent.systemPrompt,
            }

        const { id: agentId } = agentSnapshot
        const approvalMode = existingTurn?.approvalMode
          ?? _approvalMode
          ?? currentThread?.settings.approvalMode
          ?? DEFAULT_THREAD_SETTINGS.approvalMode
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

      for (const { transcript: message } of messages) {
        if (!message)
          continue

        const messageId = message.id
        const partId = message.parts[0]!.id
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

      const { approvalMode, status: _turnStatus, subagentMode, subagentRole, subagentRoles } = preparedTurn
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
    const { agentSnapshot, turnId, services, threadId } = options
    const control = options.control ?? this._turns.start(
      { threadId, turnId },
      { agentId: agentSnapshot.id, store: services.store },
    )
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
      const { store } = services

      const started = await this._start(options, store)

      hooks.onAccepted?.()
      let result: TurnResult | undefined

      if (started.cancelledAt) {
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

        for (const message of started.messages) {
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

        const model = createTrackedTurnModel({
          model: options.model,
          turnId,
          threadId,
          store,
          onRuntimeEvent: forwardEvent,
        })
        const { previousModel, start } = await this._prepareTurn(options)
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
        const aborted = control.controller.signal.aborted
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

        const status = aborted
          ? hooks.resolveAbortStatus?.() ?? 'interrupted'
          : 'failed'
        const errorMessage = error instanceof Error ? error.message : String(error)
        const interruptedOutcome = result?.outcome
        const outcome = this._normalizeOutcome(options, {
          status,
          interrupt: interruptedOutcome?.interrupt,
          errorMessage,
        })

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

      const outcome = this._normalizeOutcome(options, result!.outcome)
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
    const ownershipChanged = new Error('Turn 结算期间已被执行入口接纳')
    /** 读取和写入等待后重新检查进程所有权，避免孤立恢复覆盖正在装配的任务 */
    const assertOwnership = () => {
      if (input.shouldSettle && !input.shouldSettle())
        throw ownershipChanged
    }

    return input.store.transaction(async (tx) => {
      const current = await tx.turns.read(input.turnId)

      if (current?.threadId !== input.threadId)
        return

      const thread = await tx.threads.read(input.threadId)

      if (thread?.agentId !== this._agent.id || current.agentSnapshot.id !== this._agent.id)
        return
      const requestedAt = dayjs(input.endedAt ?? undefined)
      const currentUpdatedAt = thread ? dayjs(thread.updatedAt) : undefined
      // 元信息事务可能先推进 Thread 时间；统一结算时间必须继续单调递增，避免新事实被 SDK 当作旧快照
      const endedAt = currentUpdatedAt && !requestedAt.isAfter(currentUpdatedAt)
        ? currentUpdatedAt.add(1, 'millisecond').toISOString()
        : requestedAt.toISOString()

      assertOwnership()
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
    const { onRuntimeEvent, store, text, threadId, turnId } = input

    return this._turns.steer(threadId, turnId, async () => {
      const parts: TurnInputPart[] = [{ type: 'text', text }]
      const message = await store.transaction(async (tx) => {
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
      const transcript = message.transcript!
      const firstPart = transcript.parts[0]
      const messageId = transcript.id
      const partId = firstPart?.id
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
    const { store } = options.services
    const [thread, turns] = await Promise.all([
      store.threads.read(options.threadId),
      store.turns.list(options.threadId),
    ])
    const index = turns.findIndex(turn => turn.id === options.turnId)
    const previousTurn = index > 0 ? turns[index - 1] : undefined
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
      const current = await tx.turns.read(options.turnId)
      const thread = await tx.threads.read(options.threadId)

      if (
        !thread
        || current?.threadId !== options.threadId
        || current.status !== options.turnStatus
      ) {
        throw new Error('Turn 状态已经变化，请刷新后重试')
      }

      const started: StartedTurn = {
        messages: [],
        providerMessages: [],
        hiddenMessages: [],
      }

      if (current.status === 'interrupted') {
        const request = options.resume
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

        const resolution = await this._resolveInteraction(
          tx,
          options,
          interrupt,
          request.response,
        )

        await this._applyState(tx, options.threadId, resolution.state)

        if (resolution.action === 'cancel') {
          const cancelledAt = dayjs().toISOString()
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
          const input: TurnInputPart[] = [{
            type: 'text',
            text: resolution.input,
          }]
          const provider = providerMessage(input)
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
      const normalized = resolveLoopInteraction(interrupt, response)

      if (normalized === undefined)
        throw new Error(`未知或无效的 Loop Interaction: ${interrupt.interaction}`)
      return { action: 'resume', response: normalized, hiddenMessages: [] }
    }

    const thread = await store.threads.read(options.threadId)
    const state = this._readState(thread?.state)
    const resolution = await options.hooks?.resolveInteraction?.({ interrupt, response, state })

    if (!resolution)
      throw new Error(`未知或无效的 Interaction: ${interrupt.interaction}`)

    return { ...resolution, hiddenMessages: resolution.hiddenMessages ?? [] }
  }

  /** 在当前事务应用各扩展命名空间的结算动作 */
  private async _applyState(
    store: RuntimeStoreTx,
    threadId: string,
    resolutions?: Record<string, StateResolution>,
  ) {
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

  /** 在 Turn 稳定结算事务内运行宿主的纯状态 reducer */
  private async _settleState(
    store: RuntimeStoreTx,
    threadId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    hooks?: AgentHooks,
  ) {
    if (!hooks?.settleState)
      return

    const thread = await store.threads.read(threadId)
    const state = this._readState(thread?.state)
    const resolutions = await hooks.settleState({ status, state })

    await this._applyState(store, threadId, resolutions)
  }

  /** 从线程的持久事实读取实际扩展命名空间 */
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
    const createdAt = dayjs().toISOString()
    const messageId = createId('msg')
    const transcript: ThreadMessage = {
      id: messageId,
      threadId,
      turnId,
      role: 'user',
      kind: 'normal',
      status: 'completed',
      parts: input.map((part, index) => {
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
    const eventType = ({
      cancelled: 'turn.cancelled',
      completed: 'turn.completed',
      failed: 'turn.failed',
      interrupted: 'turn.interrupted',
    } as const)[outcome.status]
    const event = events.findLast(item => item.type === eventType)
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
