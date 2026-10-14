import type { Message, ToolResultContent, ToolResultPart } from './types.js'
import { toolCalls } from './content.js'

/** -------------------- Provider 工具结果 -------------------- */
/**
 * 创建 Provider 工具结果 Part
 */
export function createToolResultPart(
  callId: string,
  result: ToolResultContent,
  error?: boolean,
): ToolResultPart {
  return {
    type: 'tool-result',
    callId,
    result,
    ...(error ? { error } : {}),
  }
}

/**
 * 读取最近 assistant 批次中尚未生成结果的工具调用
 */
export function pendingToolCalls(messages: Message[]) {
  const batch = latestToolCallBatch(messages)

  if (!batch)
    return []

  const resolved = new Set<string>()

  for (const message of messages.slice(batch.assistantIndex + 1)) {
    if (message.role !== 'tool')
      continue

    for (const part of message.parts) {
      if (part.type === 'tool-result')
        resolved.add(part.callId)
    }
  }

  return batch.calls.filter(call => !resolved.has(call.id))
}

/**
 * 将同批工具结果去重、排序并紧邻 assistant 写入唯一 tool 消息
 */
export function attachToolResults(
  messages: Message[],
  incoming: ToolResultPart[],
) {
  const batch = latestToolCallBatch(messages)

  if (!batch)
    throw new Error('Provider 工具结果缺少对应的 assistant 工具调用批次')

  const results: ToolResultPart[] = [...incoming]
  const remainingMessages = messages
    .slice(batch.assistantIndex + 1)
    .flatMap((message) => {
      if (message.role !== 'tool')
        return [message]

      const existing = message.parts.filter((part): part is ToolResultPart => (
        part.type === 'tool-result'
      ))

      if (existing.length === 0)
        return [message]

      // 新结果覆盖同 ID 旧结果，让恢复重试保持幂等且不重复
      results.unshift(...existing)
      const remaining = message.parts.filter(part => part.type !== 'tool-result')

      return remaining.length > 0
        ? [{ ...message, parts: remaining }]
        : []
    })
  const byProviderId = new Map(results.map(result => [result.callId, result]))
  const ordered = batch.calls.flatMap((call) => {
    const result = byProviderId.get(call.id)

    if (!result)
      return []
    byProviderId.delete(call.id)

    return [result]
  })

  if (byProviderId.size > 0) {
    throw new Error(
      `Provider 工具结果不属于当前批次: ${[...byProviderId.keys()].join(', ')}`,
    )
  }

  messages.splice(
    batch.assistantIndex + 1,
    messages.length - batch.assistantIndex - 1,
    { role: 'tool', parts: ordered },
    ...remainingMessages,
  )
}

/** -------------------- 内部函数 -------------------- */
/**
 * 读取最后一个 assistant 消息中的工具调用及其原始顺序
 */
function latestToolCallBatch(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (message.role !== 'assistant')
      continue
    const calls = toolCalls(message)

    return calls.length > 0
      ? { assistantIndex: index, calls }
      : undefined
  }
  return undefined
}
