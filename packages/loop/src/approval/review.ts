import type { ToolCallPart } from '@elmino/llm'
import type { Sandbox } from '@elmino/sandbox'
import type { DefinedTool } from '@elmino/tool'
import type { PendingCall } from './types'

/** -------------------- 核心函数 -------------------- */
/**
 * 读取单个工具调用的本地审批候选
 */
export function reviewCall(
  call: ToolCallPart,
  handlers: Record<string, DefinedTool>,
  sandbox: Sandbox,
): PendingCall[] {
  if (handlers[call.name]?.approval !== 'auto')
    return []

  const reviewInput = handlers[call.name]?.review?.(call.args)

  if (!reviewInput)
    return [call]

  const review = sandbox.reviewer.approval(reviewInput)

  return review.decision === 'allow'
    ? []
    : [{ ...call, approvalReason: review.reason }]
}
