import type { ToolCallPart } from '@elmino/llm'

/** -------------------- 类型 -------------------- */
/** 需要用户确认的工具调用 */
export interface PendingCall extends ToolCallPart {
  /** 工具审批未放行的原因 */
  approvalReason?: string
}
