import type { UnknownRecord } from '@elmino/shared'
import type { ApprovalMode, ThreadTurnStatus } from './state'
import type { SubagentMode, SubagentRole } from './subagent'
import type { ThreadTokenUsage } from './usage'

/** -------------------- 类型 -------------------- */
/** Turn 记录 */
export interface RuntimeTurnRecord {
  /** turn ID */
  id: string
  /** 所属线程 ID */
  threadId: string
  /** turn 状态 */
  status: ThreadTurnStatus
  /** Turn 启动时冻结的非敏感模型解析结果 */
  modelConfig: UnknownRecord
  /** Turn 启动时冻结的子智能体角色 */
  subagentRole: SubagentRole
  /** 根 Turn 启动时冻结的可用子智能体角色目录，子线程 Turn 固定为空 */
  subagentRoles: SubagentRole[]
  /** Turn 启动时冻结的 Agent、提示词和 Skill 引用 */
  agentSnapshot: UnknownRecord
  /** 审批模式 */
  approvalMode: ApprovalMode
  /** 子智能体调度模式 */
  subagentMode: SubagentMode
  /** 创建时间 */
  createdAt: string
  /** 状态更新时间 */
  updatedAt: string
  /** 开始时间 */
  startedAt?: string
  /** 结束时间，由状态区分完成、失败或中断 */
  endedAt?: string
  /** 错误信息 */
  errorMessage: string | null
  /** 从 Step 事实派生的 token 用量 */
  usage: ThreadTokenUsage
  /** 当前 Turn 等待恢复的中断事实 */
  interrupt: UnknownRecord | null
}

/** 列表投影使用的最新 Turn 轻量记录 */
export interface RuntimeLatestTurnRecord {
  /** 所属线程 ID */
  threadId: string
  /** 当前 Turn 等待恢复的中断事实 */
  interrupt: UnknownRecord | null
}

/** 单线程累计用量记录 */
export interface RuntimeThreadUsageRecord {
  /** 所属线程 ID */
  threadId: string
  /** 当前线程全部 Turn 的累计用量 */
  usage: ThreadTokenUsage
}

/** Turn 历史 keyset 游标 */
export interface RuntimeTurnCursor {
  /** Turn 创建时间 */
  createdAt: string
  /** Turn ID，同创建时间下作为稳定次序 */
  id: string
}

/** Runtime Turn 分页参数 */
export interface RuntimeTurnPageInput {
  /** 所属线程 ID */
  threadId: string
  /** 当前页之前的 Turn 游标 */
  cursor?: RuntimeTurnCursor
  /** 本页最多返回的 Turn 数 */
  limit: number
}

/** Runtime Turn 分页结果 */
export interface RuntimeTurnPageResult {
  /** 按时间正序排列的 Turn */
  turns: RuntimeTurnRecord[]
  /** 下一页更早 Turn 的游标 */
  nextCursor?: RuntimeTurnCursor
}

/** Turn 创建参数 */
export interface CreateRuntimeTurnInput {
  /** turn ID */
  id?: string
  /** 所属线程 ID */
  threadId: string
  /** turn 状态 */
  status?: ThreadTurnStatus
  /** Turn 启动时冻结的非敏感模型解析结果 */
  modelConfig: UnknownRecord
  /** Turn 启动时冻结的子智能体角色 */
  subagentRole: SubagentRole
  /** 根 Turn 启动时冻结的可用子智能体角色目录，子线程 Turn 固定为空 */
  subagentRoles: SubagentRole[]
  /** Turn 启动时冻结的 Agent、提示词和 Skill 引用 */
  agentSnapshot: UnknownRecord
  /** 审批模式 */
  approvalMode: ApprovalMode
  /** 子智能体调度模式 */
  subagentMode: SubagentMode
  /** 创建时间 */
  createdAt?: string
  /** 开始时间 */
  startedAt?: string
}

/** Turn 更新参数 */
export interface UpdateRuntimeTurnInput {
  /** turn 状态 */
  status?: ThreadTurnStatus
  /** 开始时间 */
  startedAt?: string
  /** 结束时间，由状态区分完成、失败或中断 */
  endedAt?: string
  /** 错误信息 */
  errorMessage?: string | null
  /** 当前 Turn 等待恢复的中断事实 */
  interrupt?: UnknownRecord | null
}

/** Turn 仓储 */
export interface RuntimeTurnRepository {
  /** 创建 turn */
  create: (input: CreateRuntimeTurnInput) => Promise<RuntimeTurnRecord>
  /** 按 ID 读取 turn */
  read: (id: string) => Promise<RuntimeTurnRecord | undefined>
  /** 更新 turn */
  update: (id: string, input: UpdateRuntimeTurnInput) => Promise<RuntimeTurnRecord>
  /** 仅当 turn 仍处于指定状态时更新 */
  transition: (
    id: string,
    from: ThreadTurnStatus[],
    input: UpdateRuntimeTurnInput,
  ) => Promise<RuntimeTurnRecord | undefined>
  /** 列出线程 turn */
  list: (threadId: string) => Promise<RuntimeTurnRecord[]>
  /** 按完整 Turn 边界分页读取会话事实 */
  page: (input: RuntimeTurnPageInput) => Promise<RuntimeTurnPageResult>
  /** 列出全部 turn，用于启动校准和批量线程投影 */
  listAll: () => Promise<RuntimeTurnRecord[]>
  /** 读取指定线程最新 Turn */
  readLatest: (threadId: string) => Promise<RuntimeTurnRecord | undefined>
  /** 批量读取指定线程的最新 Turn */
  latest: (threadIds: string[]) => Promise<RuntimeLatestTurnRecord[]>
  /** 按线程聚合全部 Turn 用量 */
  listUsage: () => Promise<RuntimeThreadUsageRecord[]>
}
