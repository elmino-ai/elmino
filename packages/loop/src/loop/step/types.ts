import type { Message, TextPart } from '@elmino/llm'
import type { ActiveTurn } from '../turn/active.js'

/** -------------------- 类型 -------------------- */
/** 单次 Provider sampling 的冻结上下文 */
export interface SampleInput {
  /** 当前活动 Turn */
  readonly turn: ActiveTurn
  /** 当前 assistant 消息 ID */
  readonly messageId: string
  /** 当前 assistant 文本片段 ID */
  readonly textPartId: string
  /** 当前 assistant reasoning 片段 ID */
  readonly reasoningPartId: string
  /** 当前 Step 的 system prompt */
  readonly system: TextPart[]
  /** 续写前已经落盘的可见 reasoning */
  readonly reasoning?: string
  /** 续写前已经落盘的可见文本 */
  readonly text?: string
}

/** 单次 Step 的主循环结果 */
export interface StepResult {
  /** 主循环后续动作 */
  action: 'continue' | 'stop'
  /** 当前 Step 已提交的完整 Provider Message */
  message?: Message
}
