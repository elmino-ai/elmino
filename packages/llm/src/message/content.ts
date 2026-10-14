import type { Message, Part, ReasoningPart, TextPart, ToolCallPart } from './types'

/** -------------------- Message 内容读取 -------------------- */
/**
 * 提取消息里的可见文本
 */
export function extractText(value: Message | Part[]) {
  const parts = Array.isArray(value) ? value : value.parts

  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.text)
    .filter(Boolean)
    .join('\n')
}

/**
 * 提取消息里可展示的推理文本
 */
export function extractReasoning(value: Message | Part[]) {
  const parts = Array.isArray(value) ? value : value.parts

  return parts
    .filter((part): part is ReasoningPart => (
      part.type === 'reasoning' && part.visibility !== 'context-only'
    ))
    .map(part => part.text)
    .filter(Boolean)
    .join('\n')
}

/**
 * 读取消息里的工具调用
 */
export function toolCalls(value: Message | Part[]) {
  const parts = Array.isArray(value) ? value : value.parts

  return parts.filter((part): part is ToolCallPart => part.type === 'tool-call')
}
