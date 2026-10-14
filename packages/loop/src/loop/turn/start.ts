import type { Promisable } from '@elmino/shared'
import type { ToolExecutionContext } from '@elmino/tool'
import type { ExecutionScope } from '../../hooks/index'
import type { TurnContext, TurnInputMessage, TurnRuntimeEventEmitter } from '../types/index'
import type { ActiveTurn } from './active'
import type { TurnSnapshots } from './snapshot'
import { objectPick } from '@elmino/shared'
import {
  appendCanonicalMessages,
  createRuntimeEvent,
  readThreadSnapshot,
  ThreadCommitter,
  updateThreadExtensionState,
} from '@elmino/thread'
import { createHostServices } from '@elmino/tool'
import dayjs from 'dayjs'
import { ContextProjection } from '../../context-projection/index'
import { createTurnNotifications } from './notifications'
import { createTurnSnapshots } from './snapshot'
import { createTurnState } from './state'

/** -------------------- 核心函数 -------------------- */
/**
 * 启动一次 Loop Turn 并创建资源作用域
 */
export async function startTurn(context: TurnContext): Promise<ActiveTurn> {
  const {
    input,
    onRuntimeEvent,
    services,
    start,
    thread,
  } = context
  const {
    hiddenMessages = [],
    messages = [],
    resume,
  } = input
  const {
    approvalMode,
    model,
    turnId,
    threadId,
  } = context

  const { location } = context
  const { runtime: _runtime, store } = services
  const turnRef = objectPick(context, 'turnId', 'threadId')
  const committer = ThreadCommitter.create(store, turnRef)
  const sandbox = _runtime.sandbox()
  const { startsThread, threadSnapshot } = start

  /** 将当前 Turn 的结构化事件补齐稳定身份后交给宿主 */
  const emitRuntime: TurnRuntimeEventEmitter = async (type, payload, projection) => {
    try {
      await onRuntimeEvent?.(createRuntimeEvent({
        type,
        threadId,
        turnId,
        ...projection,
        payload,
      }))
    }
    catch (error) {
      // Runtime Event 只同步进程内/UI 投影，不能回写或改变已经确定的执行事实
      console.warn(`[loop] Runtime Event 发布失败 type=${type}`, error)
    }
  }
  const notifications = createTurnNotifications({
    threadId,
    turnId,
    emitRuntime,
  })

  // 只有真实输入或恢复命令才推进最近交互时间，纯恢复读取沿用旧时间
  const lastInteractionAt = messages.length > 0 || resume
    ? dayjs().toISOString()
    : threadSnapshot?.lastInteractionAt ?? dayjs().toISOString()
  /** 只有调用模型生成历史摘要后才写入用户可见通知 */
  const onCompact = async () => {
    const message = await committer.commitCompaction()

    await emitRuntime('message.updated', { message }, {
      messageId: message.id,
      partId: message.parts[0]!.id,
    })
  }
  let removeCompactionNotification: (() => Promise<void>) | undefined
  /** 用普通临时 EventPart 展示摘要请求，不创建第二套运行状态 */
  const onCompacting = async (compacting: boolean) => {
    if (compacting) {
      removeCompactionNotification = await notifications.show({
        title: '上下文压缩中',
        status: 'running',
      })
      return
    }
    if (!removeCompactionNotification)
      return

    await removeCompactionNotification()
    removeCompactionNotification = undefined
  }

  // 启动阶段先读历史供扩展激活，激活后所有投影都走同一份扩展处理链
  const hooks = context.hooks ?? {}
  const projection = ContextProjection.create({
    process: async messages => await hooks.processMessages?.({
      context,
      messages,
      signal: context.signal,
    }) ?? messages,
    store,
    threadId,
    model,
    state: threadSnapshot?.contextProjection ?? {},
    onCompact,
    onCompacting,
    signal: context.signal,
  })
  const contextMessages = messages.map(item => item.message)
  const firstCanonicalSeq = Math.min(
    ...messages.flatMap(item => (
      item.canonicalSeq === undefined ? [] : [item.canonicalSeq]
    )),
  )
  // 扩展用写入前的投影判断 Thread 是否已有历史，当前输入只属于本次 Turn
  const previousContextMessages = await projection.project(
    Number.isFinite(firstCanonicalSeq) ? firstCanonicalSeq - 1 : undefined,
  )

  const pendingMessages: TurnInputMessage[] = [
    ...messages.flatMap(item => (
      item.canonicalSeq === undefined
        ? [{ message: item.message, transcript: item.transcript }]
        : []
    )),
    ...hiddenMessages.map(message => ({ message })),
  ]

  if (pendingMessages.length > 0) {
    await store.transaction(async (tx) => {
      await appendCanonicalMessages(
        tx,
        pendingMessages.map(({ message }) => ({
          threadId,
          turnId,
          message,
        })),
      )
      for (const { transcript } of pendingMessages) {
        if (transcript)
          await tx.transcript.upsert(transcript)
      }
    })
  }

  const limit = model.config.limit
  const projectedContextMessages = await projection.project()
  const state = createTurnState({
    limit,
    threadSnapshot,
    contextMessages: projectedContextMessages,
  })
  /** 通过 Canonical 投影器压缩当前 Turn 的较早历史 */
  const compact = async () => {
    state.contextMessages.splice(
      0,
      state.contextMessages.length,
      ...await projection.compactHistory(),
    )

    return '[Compacted. Conversation history has been summarized.]'
  }
  const toolContext: ToolExecutionContext = {
    sandbox,
    signal: context.signal,
    services: createHostServices(context.hostServices),
  }
  let snapshots: TurnSnapshots | undefined
  let releaseStarted: (() => Promisable<void>) | undefined
  const scope: ExecutionScope = {
    context,
    snapshot: threadSnapshot,
    incomingMessages: contextMessages,
    previousMessages: previousContextMessages,
    compact,
    updateTitle: async (title) => {
      await store.threads.upsert({ id: threadId, autoTitle: title })
      const record = await readThreadSnapshot(store, threadId, location)
      const state = thread.toState(record!)
      await emitRuntime('thread.updated', state)
      return state
    },
    notify: async (notification) => {
      await notifications.show(notification)
    },
    saveSnapshot: async () => {
      await snapshots!.saveProgress()
      const record = await readThreadSnapshot(store, threadId, location)
      await emitRuntime('thread.updated', thread.toState(record!))
    },
    updateState: async (key, state) => {
      await updateThreadExtensionState(store, threadId, key, state)
      const record = await readThreadSnapshot(store, threadId, location)
      await emitRuntime('thread.updated', thread.toState(record!))
    },
  }
  /** Turn 终态先移除临时通知，再释放扩展持有的资源 */
  const dispose = async () => {
    try {
      await notifications.clear()
    }
    finally {
      await releaseStarted?.()
    }
  }

  try {
    context.signal?.throwIfAborted()
    state.contextMessages.splice(0, state.contextMessages.length, ...await projection.project())

    // 扩展先声明 Turn 贡献，再由 Loop 统一初始化 Thread 持久事实和快照生命周期
    await committer.initialize({
      ...await hooks.initialThread?.({
        context,
        previousMessages: previousContextMessages,
        snapshot: threadSnapshot,
      }),
      lastInteractionAt,
    })

    snapshots = createTurnSnapshots({
      turn: turnRef,
      emitRuntime,
      lastInteractionAt,
      state,
      projection,
      context,
      hooks,
      store,
    })
    const tools = context.tools
    await snapshots.saveProgress()

    const [startedSnapshot, runtimeTurn] = await Promise.all([
      readThreadSnapshot(
        store,
        threadId,
        location,
      ),
      store.turns.read(turnId),
    ])

    // running 快照写入后再广播，避免 Server 在标题初始化前发出 fallback
    await emitRuntime(
      'thread.updated',
      thread.toState(startedSnapshot!),
    )

    await emitRuntime('turn.started', {
      approvalMode,
      modelId: model.config.id,
      agentId: context.agentId,
      subagentMode: context.subagentMode,
      startedAt: runtimeTurn!.startedAt,
    })
    const startedRelease = await hooks.onStarted?.(scope)
    if (startedRelease)
      releaseStarted = startedRelease

    if (startsThread) {
      await hooks.onLifecycle?.('thread.start', {
        context,
        signal: context.signal,
        payload: {},
      })
    }

    await hooks.onLifecycle?.('turn.start', {
      context,
      signal: context.signal,
      payload: {},
    })

    const submittedMessages = contextMessages.filter(message => (
      message.role === 'user'
    ))

    if (submittedMessages.length > 0) {
      await hooks.onLifecycle?.('user.prompt.submit', {
        context,
        signal: context.signal,
        payload: { messages: submittedMessages },
      })
    }

    return {
      context,
      emitRuntime,
      projection,
      committer,
      snapshots,
      state,
      hooks,
      tools,
      toolContext,
      dispose,
    }
  }
  catch (error) {
    try {
      await dispose()
    }
    catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Turn 启动失败且释放函数执行失败',
      )
    }

    throw error
  }
}
