import type { UnknownRecord } from '@elmino/shared'
import type { PaginationResult } from '../pagination/types'
import type { ThreadListSummary, ThreadSearchHit } from '../thread/search'
import type { ThreadSettings } from '../thread/settings'
import type { ThreadStatus } from './state'

/** -------------------- 类型 -------------------- */
/** 线程删除生命周期 */
export type RuntimeThreadLifecycle = 'active' | 'deleting'

/** 线程记录 */
export interface RuntimeThreadRecord {
  /** 线程 ID */
  id: string
  /** 相对项目根目录的执行目录 */
  dir: string
  /** 线程删除生命周期 */
  lifecycle: RuntimeThreadLifecycle
  /** 线程固定所属的 Agent */
  agentId: string
  /** 已有标题；缺省展示文案由宿主决定 */
  title?: string
  /** 自动生成标题 */
  autoTitle: string | null
  /** 用户自定义标题 */
  userTitle: string | null
  /** 线程整体状态 */
  status: ThreadStatus
  /** 是否置顶 */
  pinned: boolean
  /** 最近一次尚未阅读的根 Turn 完成时间 */
  unreadAt: string | null
  /** 归档时间 */
  archivedAt: string | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 最近交互时间 */
  lastInteractionAt: string
  /** 线程级稳定扩展元信息 */
  metadata: UnknownRecord
  /** 后续 Turn 使用的线程级发送设置 */
  settings: ThreadSettings
  /** 线程当前可恢复状态 */
  state: UnknownRecord
}

/** 根线程列表分页查询参数 */
export interface RuntimeThreadPageInput {
  /** 是否查询归档线程 */
  archived: boolean
  /** 返回条数 */
  limit: number
  /** 只读取当前属于指定 Agent 的线程 */
  agentId?: string
}

/** 根线程列表分页查询结果 */
export interface RuntimeThreadPageResult extends PaginationResult<RuntimeThreadRecord> {
  /** 当前全部运行中根线程 ID */
  runningThreadIds: string[]
  /** 当前过滤范围的完整统计，不受分页 limit 影响 */
  summary: ThreadListSummary
}

/** 线程写入参数 */
export interface UpsertRuntimeThreadInput {
  /** 线程 ID */
  id: string
  /** 相对项目根目录的执行目录，创建时必填 */
  dir?: string
  /** 线程删除生命周期 */
  lifecycle?: RuntimeThreadLifecycle
  /** 创建线程时固定所属的 Agent */
  agentId?: string
  /** 自动生成标题 */
  autoTitle?: string | null
  /** 用户自定义标题 */
  userTitle?: string | null
  /** 线程整体状态 */
  status?: ThreadStatus
  /** 是否置顶 */
  pinned?: boolean
  /** 最近一次尚未阅读的根 Turn 完成时间 */
  unreadAt?: string | null
  /** 归档时间 */
  archivedAt?: string | null
  /** 创建时间 */
  createdAt?: string
  /** 更新时间 */
  updatedAt?: string
  /** 最近交互时间 */
  lastInteractionAt?: string
  /** 线程级稳定扩展元信息 */
  metadata?: UnknownRecord
  /** 后续 Turn 使用的线程级发送设置 */
  settings?: ThreadSettings
  /** 线程当前可恢复状态 */
  state?: UnknownRecord
}

/** 线程仓储 */
export interface RuntimeThreadRepository {
  /** 在指定 Agent 的未归档主聊天中搜索，空关键词返回最近会话 */
  search: (agentId: string, query: string, limit: number) => Promise<ThreadSearchHit[]>
  /** 写入或更新线程 */
  upsert: (input: UpsertRuntimeThreadInput) => Promise<RuntimeThreadRecord>
  /** 原子归档全部未归档根线程 */
  archiveAll: (archivedAt: string) => Promise<RuntimeThreadRecord[]>
  /** 读取线程 */
  read: (id: string) => Promise<RuntimeThreadRecord | undefined>
  /** 列出全部线程，用于运行恢复 */
  listAll: () => Promise<RuntimeThreadRecord[]>
  /** 分页读取根线程稳定前缀 */
  page: (input: RuntimeThreadPageInput) => Promise<RuntimeThreadPageResult>
  /** 条件切换线程删除生命周期 */
  transitionLifecycle: (
    id: string,
    from: RuntimeThreadLifecycle,
    to: RuntimeThreadLifecycle,
  ) => Promise<RuntimeThreadRecord | undefined>
  /** 删除线程及其所有运行事实 */
  remove: (id: string) => Promise<void>
}
