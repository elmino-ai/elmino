import type { ThreadLocation } from '@elmino/runtime'
import type { JsonValue, UnknownRecord } from '@elmino/shared'
import type { ApprovalMode, SubagentMode, ThreadMessage, ThreadSettings, ThreadTurnStatus } from '@elmino/store'
import type { ThreadInterrupt } from '../runtime/interrupt'
import type { ThreadRuntimeState } from '../runtime/state'

/** -------------------- 类型 -------------------- */
/** 单个 Turn 的执行时间线摘要 */
export interface ThreadTurnState {
  /** Turn ID */
  id: string
  /** Turn 状态 */
  status: ThreadTurnStatus
  /** Turn 冻结的 Agent ID */
  agentId: string
  /** Turn 冻结的模型配置身份 */
  modelId?: string
  /** Turn 冻结的工具审批模式 */
  approvalMode?: ApprovalMode
  /** Turn 冻结的子智能体模式 */
  subagentMode?: SubagentMode
  /** 最后错误或中断原因，来自持久化执行事实 */
  message?: string
  /** 此 Turn 持久化的中断事实，不替换为线程后来一轮的交互 */
  interrupt?: ThreadInterrupt
  /** Turn 开始时间，排队中时不存在 */
  startedAt?: string
  /** Turn 结束时间 */
  endedAt?: string
}

/** 父线程直接派生的子线程执行投影 */
export interface ThreadChildState {
  /** 创建子线程的能力所有者 */
  ownerId: string
  /** 子线程 ID */
  threadId: string
  /** 子线程当前 Turn ID */
  turnId: string
  /** 父线程触发子线程的工具调用 ID */
  parentToolCallId: string
  /** 子线程已有标题 */
  title?: string
  /** 子线程当前 Turn 的原始状态 */
  status: ThreadTurnStatus
  /** 当前 Turn 中断事实 */
  interrupt?: ThreadInterrupt
  /** 所有者专属 JSON 数据 */
  data: Record<string, JsonValue>
  /** 创建时间 */
  createdAt: string
  /** 开始时间 */
  startedAt?: string
  /** 结束时间 */
  endedAt?: string
  /** 状态更新时间 */
  updatedAt: string
}

/** 可由宿主消费的完整线程数据投影，不持有 UI 或客户端缓存 */
export interface ThreadState extends Pick<ThreadLocation, 'workspaceId' | 'workspaceRoot' | 'cwd'> {
  /** 线程 ID */
  threadId: string
  /** 已有标题；缺省展示文案由宿主决定 */
  title?: string
  /** 固定所属 Agent ID */
  agentId: string
  /** 是否置顶 */
  pinned: boolean
  /** 最近一次未读根 Turn 完成时间 */
  unreadAt: string | null
  /** 归档时间 */
  archivedAt: string | null
  /** 创建时间 */
  createdAt: string
  /** 最近交互时间 */
  lastInteractionAt: string
  /** 更新时间 */
  updatedAt: string
  /** 已持久化并完成执行事实校准的消息 */
  messages: ThreadMessage[]
  /** Turn 时间线摘要 */
  turns: ThreadTurnState[]
  /** 直接派生的子线程投影 */
  children: ThreadChildState[]
  /** 从内部命名空间恢复状态映射出的公开扩展状态 */
  extensions: Record<string, UnknownRecord>
  /** 后续 Turn 使用的设置 */
  settings: ThreadSettings
  /** 当前运行状态 */
  runtime: ThreadRuntimeState
}

/** 线程仓储轻量列表投影 */
export interface ThreadListItem extends Pick<
  ThreadState,
  | 'threadId'
  | 'title'
  | 'workspaceId'
  | 'agentId'
  | 'pinned'
  | 'unreadAt'
  | 'archivedAt'
  | 'lastInteractionAt'
  | 'updatedAt'
  | 'settings'
> {
  /** 最新 Turn 所需的运行态摘要 */
  runtime: Pick<ThreadRuntimeState, 'interrupt' | 'status'>
}
