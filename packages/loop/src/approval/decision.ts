import type { ToolCallPart } from '@elmino/llm'
import type { ToolApprovalDecision, ToolApprovalResume } from '@elmino/tool'
import { isPlainRecord } from '@elmino/shared'

/** -------------------- 审批决策 -------------------- */
/**
 * 将恢复决策按 Provider 工具调用 ID 建索引
 */
export function readApprovalDecisions(
  resume: ToolApprovalResume | undefined,
) {
  const decisions = new Map<string, ToolApprovalDecision>()

  for (const decision of resume?.decisions ?? []) {
    if (decisions.has(decision.callId))
      throw new Error(`重复的审批决策: ${decision.callId}`)

    decisions.set(decision.callId, decision)
  }

  return decisions
}

/**
 * 根据审批决策得到实际执行的工具调用
 */
export function applyApproval(
  call: ToolCallPart,
  decision: ToolApprovalDecision,
) {
  if (decision.type !== 'edit')
    return call

  if (!isPlainRecord(decision.editedAction.args))
    throw new Error(`工具 ${decision.editedAction.name} 的编辑参数必须是对象`)

  // editedAction.args 与公共工具调用使用同一字段，不再经过 Provider 原生字段转换
  return {
    ...call,
    name: decision.editedAction.name,
    args: decision.editedAction.args,
  } satisfies ToolCallPart
}

/**
 * 读取不需要真实执行工具的人工决策结果
 */
export function decisionOutput(
  call: ToolCallPart,
  decision: ToolApprovalDecision,
) {
  if (decision.type === 'reject') {
    return decision.message
      ?? `Tool call ${call.name} was rejected by the user. Do not retry the same action unless the user asks.`
  }

  if (decision.type === 'respond')
    return decision.message

  return undefined
}
