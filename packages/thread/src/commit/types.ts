import type { Message } from '@elmino/llm'
import type { ThreadMessageStatus } from '@elmino/store'
import type { ThreadSnapshotUpdate, ThreadToolPartProjector } from '../thread/types.js'

/** -------------------- 类型 -------------------- */
/** Thread 持久提交所需 Turn 标识 */
export interface TurnRef {
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
}

/** 初始化 RuntimeStore Thread 入参 */
export interface InitializeInput {
  /** 初始化自动标题 */
  autoTitle?: string
  /** 最近交互时间 */
  lastInteractionAt: string
}

/** 上下文压缩边界的宿主可定制展示数据 */
export interface CompactionInput {
  /** 合成事件标题；缺省使用 context.compacted 语义名称 */
  title?: string
}

/** assistant 消息稳定标识 */
export interface MessageRef {
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
  /** 当前 assistant 消息 ID */
  messageId: string
  /** 当前 assistant 文本片段 ID */
  textPartId: string
  /** 当前 assistant reasoning 片段 ID */
  reasoningPartId: string
}

/** 运行中 Step 的 transcript 检查点 */
export interface CheckpointInput extends MessageRef {
  /** 当前已经展示的完整文本 */
  text: string
  /** 当前已经展示的完整 reasoning 文本 */
  reasoning: string
}

/** 提交 provider step 入参 */
export interface StepCommitInput extends MessageRef {
  /** Provider Result 返回的唯一完整 Message */
  message: Message
  /** 工具调用未执行时写入 Runtime activity 的失败原因 */
  toolFailure?: string
  /** 从完整 Provider Message 聚合出的 transcript 文本 */
  text: string
  /** 从完整 Provider Message 聚合出的 transcript reasoning */
  reasoning: string
  /** 与响应一起原子提交的下一轮上下文快照 */
  snapshot: ThreadSnapshotUpdate
  /** 按工具名索引的消息隐藏标记 */
  hiddenTools: Readonly<Record<string, boolean | undefined>>
  /** 当前宿主提供的工具消息投影 */
  projectToolPart: ThreadToolPartProjector
}

/** 结算失败或中断的 assistant 消息入参 */
export interface PartialCommitInput extends MessageRef {
  /** 失败或中断前已经展示的安全文本 */
  text: string
  /** 失败或中断前已经展示的安全 reasoning 文本 */
  reasoning: string
  /** assistant 消息终态 */
  status: Extract<ThreadMessageStatus, 'failed' | 'interrupted'>
  /** 与 transcript 终态一起提交的下一轮上下文快照 */
  snapshot: ThreadSnapshotUpdate
}
