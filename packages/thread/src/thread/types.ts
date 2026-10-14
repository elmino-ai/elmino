import type { ToolCallPart } from '@elmino/llm'
import type { ThreadLocation } from '@elmino/runtime'
import type { ExcludeStrict, SetRequired, UnknownRecord } from '@elmino/shared'
import type { ThreadMessage, ThreadPart, ThreadPartStatus, ThreadTokenUsage } from '@elmino/store'
import type { ThreadRuntimeState } from '../runtime/state.js'
import type { ThreadChildState, ThreadState, ThreadTurnState } from './state.js'

/** -------------------- 快照类型 -------------------- */
/** 从 Canonical 历史重建 Provider Context 所需的最小状态 */
export interface ContextProjectionState {
  /** 当前滑动摘要及其不可变历史边界 */
  summary?: {
    /** LLM 生成的历史摘要 */
    text: string
    /** 摘要覆盖到的 Canonical Message seq */
    throughSeq: number
    /** 摘要覆盖到的 Canonical Message ID */
    throughMessageId: string
  }
}

/** 线程快照从 ThreadState 继承稳定展示字段，用于重建对外线程状态 */
type ThreadSnapshotStateFields = Pick<
  ThreadState,
  | 'agentId'
  | 'archivedAt'
  | 'createdAt'
  | 'lastInteractionAt'
  | 'threadId'
  | 'updatedAt'
>

/** 线程快照写入前允许缺省、归一化时补齐的展示字段 */
type OptionalThreadSnapshotStateFields = Partial<
  Pick<
    ThreadState,
    | 'pinned'
    | 'settings'
  >
> & {
  /** 自动生成标题 */
  autoTitle?: string | null
  /** 用户自定义标题 */
  userTitle?: string | null
  /** 最近一次尚未阅读的根 Turn 完成时间 */
  unreadAt?: string | null
}

/** 线程快照允许保存且不能完全从结构化 Turn 还原的运行态字段 */
type ThreadSnapshotRuntimeFields = Partial<Pick<
  ThreadRuntimeState,
  | 'approvalMode'
  | 'contextBudget'
  | 'interrupt'
  | 'turnId'
  | 'status'
  | 'usage'
>>

/** 单个线程恢复快照 */
export interface ThreadSnapshotRecord
  extends
  ThreadSnapshotStateFields,
  OptionalThreadSnapshotStateFields,
  ThreadSnapshotRuntimeFields {
  /** Canonical 历史的可恢复投影状态 */
  contextProjection: ContextProjectionState
  /** 当前线程稳定存储作用域与实际执行位置 */
  location: ThreadLocation
  /** 按命名空间稳定 ID 保存的权威恢复状态 */
  extensionState: ThreadExtensionState
  /** 当前模型配置 ID */
  modelId?: string
}

/** 线程快照局部更新，只允许写入不能从结构化 Thread/Turn 事实还原的上下文 */
export type ThreadSnapshotUpdate = Partial<Pick<
  ThreadSnapshotRecord,
  | 'contextProjection'
  | 'contextBudget'
  | 'lastInteractionAt'
>> & {
  /** 只覆盖指定扩展命名空间的状态增量 */
  extensionStatePatch?: ThreadExtensionStatePatch
}

/** 创建线程快照记录的输入，强制调用方提供线程和项目身份 */
export type CreateThreadSnapshotRecordInput = SetRequired<
  Partial<ThreadSnapshotRecord>,
  | 'threadId'
  | 'agentId'
  | 'location'
>

/** 已补齐运行态默认值的线程快照记录 */
export type NormalizedThreadSnapshotRecord = SetRequired<
  ThreadSnapshotRecord,
  | 'approvalMode'
  | 'autoTitle'
  | 'userTitle'
  | 'pinned'
  | 'extensionState'
  | 'settings'
  | 'status'
  | 'unreadAt'
  | 'usage'
  | 'location'
>

/** -------------------- 转换类型 -------------------- */
/** 按命名空间稳定 ID 保存的线程恢复状态 */
export type ThreadExtensionState = Record<string, UnknownRecord>

/** 单次快照只更新当前活跃扩展拥有的命名空间 */
export type ThreadExtensionStatePatch = Record<string, UnknownRecord>

/** 线程协议状态附加的运行事实 */
export interface ThreadStateInput {
  /** 已持久化并合并流式增量的消息 */
  messages?: ThreadMessage[]
  /** Turn 时间线 */
  turns?: ThreadTurnState[]
  /** 直接派生的子线程投影 */
  children?: ThreadChildState[]
  /** 当前线程及所有派生子线程的累计用量 */
  taskUsage?: ThreadTokenUsage
}

/** 将线程内部恢复事实投影为宿主线程数据状态 */
export interface Thread {
  /** 将内部线程快照转换为协议状态 */
  toState: (
    record: ThreadSnapshotRecord,
    input?: ThreadStateInput,
  ) => ThreadState
}

/** Thread transcript 可持久化的自定义工具消息片段 */
export interface ThreadToolPart {
  /** 消息片段稳定 ID */
  id: string
  /** 已受 RuntimeStore 和协议约束的片段类型 */
  type: ExcludeStrict<ThreadPart['type'], 'tool'> | 'artifact_ref'
  /** 当前片段状态 */
  status: ThreadPartStatus
  /** 可选文本正文 */
  text?: string
  /** 类型专属结构化数据 */
  json?: UnknownRecord
}

/** 工具消息投影回调 */
export type ThreadToolPartProjector = (input: {
  /** 当前 Provider 工具调用 */
  part: ToolCallPart
  /** 当前投影阶段 */
  phase: 'streaming' | 'completed'
}) => Promise<{
  /** 是否接管默认工具消息投影 */
  handled: boolean
  /** 接管后写入的自定义消息片段 */
  part?: ThreadToolPart
}>
