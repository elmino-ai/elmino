import type { UnknownRecord } from '@elmino/shared'
import type { ThreadPart } from './parts.js'

/** -------------------- 类型 -------------------- */
/** 持久化 transcript 消息角色，工具结果归所属 assistant 消息 */
export type ThreadMessageRole = 'assistant' | 'system' | 'user'

/** transcript 消息状态 */
export type ThreadMessageStatus = 'completed' | 'created' | 'failed' | 'interrupted' | 'streaming'

/** transcript 消息内部类型 */
export type ThreadMessageKind = 'error' | 'normal' | 'synthetic'

/** 持久化 transcript 消息投影，独立于模型 Canonical 消息 */
export interface ThreadMessage {
  /** 消息 ID */
  id: string
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId: string
  /** 消息角色 */
  role: ThreadMessageRole
  /** 消息内部类型 */
  kind: ThreadMessageKind
  /** 消息状态 */
  status: ThreadMessageStatus
  /** 按原始顺序保存的完整消息片段 */
  parts: ThreadPart[]
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 消息扩展元信息 */
  metadata: UnknownRecord
}
