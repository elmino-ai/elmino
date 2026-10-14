import type { ToolCallPart } from '@elmino/llm'
import type { RuntimeToolCallRecord, RuntimeToolDecision as ToolRuntimeDecision } from '@elmino/store'
import type { ToolApprovalDecision } from '@elmino/tool'
import type { ActiveTurn } from '../turn/active.js'

/** -------------------- 类型 -------------------- */
/** 单次工具调用的完整执行事实 */
export interface ToolInvocation {
  /** 当前活动 Turn */
  readonly turn: ActiveTurn
  /** 已提交且可执行的 Provider 工具调用 */
  readonly call: ToolCallPart
  /** 当前审批决策 */
  readonly decision: ToolApprovalDecision
  /** Runtime 事件中的决策来源 */
  readonly decisionType: ToolRuntimeDecision
  /** 当前工具调用的 RuntimeStore 归属 */
  readonly ownership: RuntimeToolCallRecord
}
