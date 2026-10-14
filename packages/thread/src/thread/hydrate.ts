import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import { projectTranscriptMessages } from './message-transform.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 从 RuntimeStore 读取并转换线程消息
 */
export async function hydrateThreadMessages(input: {
  /** RuntimeStore 实例 */
  store: RuntimeStore
  /** 当前线程 ID */
  threadId: string
  /** 只读取指定 Turn */
  turnIds?: string[]
}): Promise<ThreadMessage[]> {
  const { store, threadId, turnIds } = input
  const [
    messages,
    toolCalls,
  ] = await Promise.all([
    store.transcript.list(threadId, turnIds),
    store.toolCalls.list({ threadId }),
  ])
  const turnIdSet = turnIds ? new Set(turnIds) : undefined
  const scopedToolCalls = turnIdSet
    ? toolCalls.filter(toolCall => turnIdSet.has(toolCall.turnId))
    : toolCalls
  const toolResults = await store.canonical.readParts(
    threadId,
    scopedToolCalls.flatMap(toolCall => (
      toolCall.resultPartId ? [toolCall.resultPartId] : []
    )),
  )

  return projectTranscriptMessages(
    messages,
    scopedToolCalls,
    toolResults,
  )
}
