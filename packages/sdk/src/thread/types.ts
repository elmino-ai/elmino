import type { AgentWorkspaceTarget, ApiClient, ApiThreadTranscriptInput } from '@elmino/api'
import type { JsonValue } from '@elmino/shared'
import type { ThreadState } from '@elmino/thread'
import type { ToolApprovalDecision } from '@elmino/tool'
import type {
  ClientInteraction,
  ClientObserveOptions,
  ClientRun,
  ClientRunOptions,
  ClientRunResult,
  ClientThreadRunOptions,
} from '../run/types'
import type { ThreadWatchOptions } from './watch'

/** 一次绑定 Agent、工作区和会话；省略线程身份只在客户端预分配，首次运行才持久化 */
export interface ClientThreadOptions extends AgentWorkspaceTarget {
  /** 恢复既有会话时提供，省略时生成新身份 */
  threadId?: string
}

/** 供无框架订阅、Composer 和 React 共享的引用稳定快照 */
export interface ClientThreadSnapshot {
  /** 服务端线程与本地已接纳增量，尚未创建会话时为空 */
  thread?: ThreadState
  /** 当前句柄的本地观察连接，不代表远端任务执行状态 */
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
  /** 最近一次连接、读取或投影错误，成功校准后清除 */
  error?: unknown
}

/** 固定身份的远端会话；实现工厂与事件调度不属于公开 API */
export interface ClientThread {
  /** 已注册 Agent */
  readonly agentId: string
  /** 服务端工作区 */
  readonly workspaceId: string
  /** 后续调用沿用的会话身份 */
  readonly threadId: string
  /** 发送新一轮并等待终态 */
  run: (input: ClientRunOptions['input'], options?: ClientThreadRunOptions) => Promise<ClientRunResult>
  /** 立即返回执行句柄，提交和终态分别等待 accepted 与 completed */
  start: (input: ClientRunOptions['input'], options?: ClientThreadRunOptions) => ClientRun
  /** 重新观察已存在的 Turn，不重复提交 */
  attach: (turnId: string, options?: ClientObserveOptions) => ClientRun
  /** 读取权威线程并更新本地快照 */
  get: (options?: { signal?: AbortSignal }) => Promise<ThreadState>
  /** 读取包含失败原因和冻结执行策略的运行摘要 */
  listTurns: (options?: { signal?: AbortSignal }) => ReturnType<ApiClient['thread']['listTurns']>
  /** 按完整 Turn 向前翻页，返回页内消息保持时间正序 */
  readTranscript: (input?: Pick<ApiThreadTranscriptInput, 'cursor' | 'limit'>, options?: { signal?: AbortSignal }) => ReturnType<ApiClient['thread']['readTranscript']>
  /** 返回引用稳定的当前快照，不隐式发送请求 */
  getSnapshot: () => ClientThreadSnapshot
  /** 首位订阅者建立观察，最后退订时释放当前句柄的连接与计时器 */
  subscribe: (listener: () => void) => () => void
  /** 异步快照消费；慢回调与其他观察者、运行句柄相互隔离 */
  watch: (listener: (state: ThreadState) => void | Promise<void>, options?: ThreadWatchOptions) => () => void
  /** 使用准确的交互身份恢复原 Turn，立即返回可停止的句柄 */
  resume: (interaction: ClientInteraction, response: JsonValue, options?: ClientObserveOptions) => ClientRun
  /** 批准全部待审批工具，等待 completed 获得恢复结果 */
  approve: (interaction: ClientInteraction, options?: ClientObserveOptions) => ClientRun
  /** 拒绝全部工具后继续推理，取消任务使用 cancel */
  reject: (interaction: ClientInteraction, message?: string, options?: ClientObserveOptions) => ClientRun
  /** 完整提交本批各工具的 approve、reject、edit 或 respond 决策 */
  respond: (interaction: ClientInteraction, decisions: ToolApprovalDecision[], options?: ClientObserveOptions) => ClientRun
  /** 取消准确的待交互任务并等待取消事务完成 */
  cancel: (interaction: ClientInteraction, reason?: string, options?: { signal?: AbortSignal }) => Promise<ClientRunResult>
}
