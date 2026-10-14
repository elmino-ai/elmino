import type { Message } from '@elmino/llm'

/** -------------------- 类型 -------------------- */
/** 输出截断续写中的可见 assistant 回复状态 */
interface OutputContinuationState {
  /** 当前可见 assistant 消息 ID */
  messageId: string
  /** 当前可见 assistant reasoning 片段 ID */
  reasoningPartId: string
  /** 当前可见 assistant 文本片段 ID */
  textPartId: string
  /** 已经写入 reasoning 片段的可见推理文本 */
  reasoning: string
  /** 已经写入可见文本片段的 assistant 文本 */
  text: string
}

/** 错误恢复数据 */
export interface RecoveryStatus {
  /** 是否已经提升过输出预算 */
  hasEscalatedOutputBudget: boolean

  /** 升级输出预算后仍截断时，已经追加续写提示的次数 */
  continuationCount: number

  /** 输出截断续写期间复用的可见 assistant 回复 */
  outputContinuation?: OutputContinuationState

  /** 仅供当前 Turn 下一次 sampling 使用、不写入 Thread Context 的纠偏提示 */
  requestPrompt?: Message

  /** prompt_too_long 后是否已经执行过兜底压缩 */
  hasAttemptedReactiveCompact: boolean

  /** 空可见回复恢复次数 */
  emptyResponseCount: number
}
