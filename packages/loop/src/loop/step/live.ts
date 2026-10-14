import type { Event, ToolCallPart } from '@elmino/llm'
import type { ThreadPart } from '@elmino/store'
import type { SampleInput } from './types.js'
import { projectLiveToolPart } from '@elmino/thread'
import dayjs from 'dayjs'
import { readPartialToolArgs } from './tool-input.js'

/** -------------------- 类型 -------------------- */
/** 临时 UI Part 的稳定范围 */
interface LiveScope {
  /** 当前 assistant 消息 ID */
  messageId: string
  /** 当前 Turn ID */
  turnId: string
  /** 当前线程 ID */
  threadId: string
}

/** 单个工具调用的临时参数草稿 */
interface LiveToolDraft {
  /** Provider 已声明的工具调用 */
  call: ToolCallPart
  /** 已累计但可能尚未闭合的参数 JSON */
  argsText: string
  /** 首次收到该工具调用的时间 */
  startedAt: string
}

/** -------------------- 常量 -------------------- */
/** 运行中正文与 reasoning 的最短持久化间隔 */
const CHECKPOINT_INTERVAL_MS = 10_000

/** -------------------- Live UI 投影 -------------------- */
/**
 * 投影流式 Event，并为可刷新恢复的正文与 reasoning 维护 transcript 检查点
 */
export function createLiveView(input: SampleInput) {
  const {
    messageId,
    reasoning: initialReasoning = '',
    reasoningPartId,
    text: initialText = '',
    textPartId,
    turn,
  } = input
  const { committer, context, emitRuntime, hooks, tools } = turn
  const { threadId, turnId } = context
  const scope = { messageId, threadId, turnId }
  const toolDrafts = new Map<number, LiveToolDraft>()
  const partIds = new Set<string>()
  const textScope = { messageId, partId: textPartId }
  let text = initialText
  let reasoning = initialReasoning
  let checkpointText = initialText
  let checkpointReasoning = initialReasoning
  let checkpointAt = 0

  /** 隔离 UI 投影失败，避免本地观察者错误伪装成 Provider 错误 */
  const publish = async (project: () => Promise<void>) => {
    try {
      await project()
    }
    catch {
      // Event 不是恢复事实，最终 Message 会在持久提交后校准 UI
    }
  }

  /** 建立 Store 锚点并清空上一次 transient 候选 */
  const start = async () => {
    const part = await committer.checkpoint({
      messageId,
      textPartId,
      reasoningPartId,
      reasoning: initialReasoning,
      text: initialText,
    })

    // 完整 Part 先为 live cache 建立前缀，再允许后续 delta 追加
    await publish(() => emitRuntime('message.part.updated', { part }, textScope))
  }

  /** 按时间节流保存刷新和进程中断时可恢复的内容 */
  const checkpoint = async () => {
    const now = dayjs().valueOf()
    const startsText = text !== initialText && checkpointText === initialText
    const startsReasoning = reasoning !== initialReasoning
      && checkpointReasoning === initialReasoning

    if (
      !startsText
      && !startsReasoning
      && checkpointAt > 0
      && now - checkpointAt < CHECKPOINT_INTERVAL_MS
    ) {
      return
    }

    await committer.checkpoint({
      messageId,
      textPartId,
      reasoningPartId,
      reasoning,
      text,
    })
    checkpointText = text
    checkpointReasoning = reasoning
    checkpointAt = now
  }

  /** 将工具草稿投影为扩展 Part 或标准工具 Part */
  const projectTool = async (call: ToolCallPart, index: number, startedAt: string) => {
    const projection = await hooks.projectTool?.({
      context,
      signal: context.signal,
      part: call,
      phase: 'streaming',
    }) ?? { handled: false }

    if (projection.handled) {
      if (projection.part) {
        const seq = index + 2
        const part = projectLiveToolPart({
          part: projection.part,
          messageId,
          threadId,
          turnId,
          seq,
          createdAt: startedAt,
        })

        partIds.add(part.id)
        await emitRuntime('message.part.updated', { part }, {
          messageId,
          partId: part.id,
        })
      }
      return
    }

    const { hidden } = tools.handlers[call.name] ?? {}
    const part = createLiveToolPart(scope, call, index + 2, startedAt, hidden)

    partIds.add(part.id)
    await emitRuntime('message.part.updated', { part }, {
      messageId,
      partId: part.id,
    })
  }

  /** 投影单个统一流事件 */
  const onEvent = async (event: Event) => {
    if (event.type === 'part-delta' && event.delta.type === 'text') {
      const delta = event.delta.text

      text += delta
      if (delta) {
        partIds.add(textPartId)
        // 检查点失败不改变 Provider sampling；最终 Message 仍负责持久提交和 UI 校准
        await checkpoint().catch(() => undefined)
        await publish(() => emitRuntime('message.part.delta', {
          delta: { text: delta },
        }, textScope))
      }
      return
    }

    await publish(async () => {
      if (event.type === 'part-delta' && event.delta.type === 'reasoning') {
        const delta = event.delta.text

        if (!delta)
          return

        reasoning += delta
        await checkpoint().catch(() => undefined)
        const partId = reasoningPartId

        if (!partIds.has(partId)) {
          const part = createLiveReasoningPart(
            scope,
            reasoningPartId,
            initialReasoning,
            dayjs().toISOString(),
          )

          partIds.add(partId)
          await emitRuntime('message.part.updated', { part }, {
            messageId,
            partId,
          })
        }

        await emitRuntime('message.part.delta', {
          delta: { text: delta },
        }, {
          messageId,
          partId,
        })
        return
      }

      if (event.type === 'part-delta' && event.delta.type === 'tool-args') {
        const draft = toolDrafts.get(event.index)

        if (!draft)
          return

        draft.argsText += event.delta.text
        const args = readPartialToolArgs(draft.argsText)

        if (!args)
          return

        draft.call = {
          type: 'tool-call',
          id: draft.call.id,
          name: draft.call.name,
          args,
          argsText: draft.argsText,
          metadata: draft.call.metadata,
        }
        await projectTool(draft.call, event.index, draft.startedAt)
        return
      }

      if (
        (event.type !== 'part-start' && event.type !== 'part-end')
        || event.part.type !== 'tool-call'
      ) {
        return
      }

      const call = event.part
      const draft = toolDrafts.get(event.index)
      const startedAt = draft?.startedAt ?? dayjs().toISOString()

      if (event.type === 'part-start') {
        // Adapter 保证工具 start 只带稳定身份，参数草稿只累加 tool-args
        toolDrafts.set(event.index, { call, argsText: '', startedAt })
      }
      else {
        toolDrafts.delete(event.index)
      }

      await projectTool(call, event.index, startedAt)
    })
  }

  /** 丢弃失败 sampling 的全部临时 Part */
  const discard = async () => {
    // Store 检查点保留给恢复；只有未提交候选才需要从 live 投影移除
    await Promise.all([...partIds].map(partId => publish(() => (
      emitRuntime('message.part.removed', {}, {
        messageId,
        partId,
      })
    ))))
  }

  /** 读取失败或中断前已经收到的安全文本 */
  const readText = () => text

  /** 读取失败或中断前已经收到的安全 reasoning */
  const readReasoning = () => reasoning

  return {
    discard,
    onEvent,
    readReasoning,
    readText,
    start,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 创建与持久检查点共用稳定 ID 的 live reasoning Part
 */
function createLiveReasoningPart(
  scope: LiveScope,
  partId: string,
  text: string,
  createdAt: string,
): ThreadPart {
  const { messageId, threadId, turnId } = scope

  return {
    id: partId,
    messageId,
    threadId,
    turnId,
    seq: 0,
    type: 'reasoning',
    status: 'running',
    text,
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * 创建只用于 Runtime Event 的临时工具 Part
 */
function createLiveToolPart(
  scope: LiveScope,
  call: ToolCallPart,
  seq: number,
  createdAt: string,
  hidden?: boolean,
): ThreadPart {
  const { messageId, threadId, turnId } = scope
  const { args, id, name } = call

  return {
    id: `${messageId}:tool:${id}`,
    messageId,
    threadId,
    turnId,
    seq,
    type: 'tool',
    status: 'running',
    providerCallId: id,
    toolName: name,
    args,
    hidden,
    createdAt,
    updatedAt: createdAt,
  }
}
