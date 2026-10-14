import type { UnknownRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 工具调用状态 */
export type RuntimeToolCallStatus
  = | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped'

/** 工具审批决策归属 */
export type RuntimeToolDecision = 'auto' | 'approve' | 'reject' | 'edit' | 'respond'

/** Tool Call 记录，线程和消息归属从 Turn 与 Part 派生 */
export interface RuntimeToolCallRecord {
  /** 工具调用 ID */
  id: string
  /** 所属线程 ID */
  threadId: string
  /** 所属 turn ID */
  turnId: string
  /** assistant tool part ID */
  assistantPartId: string
  /** assistant transcript message ID */
  assistantMessageId: string
  /** Provider 原始工具调用 ID */
  providerCallId: string
  /** 工具名 */
  name: string
  /** 工具参数 */
  args: UnknownRecord
  /** 工具状态 */
  status: RuntimeToolCallStatus
  /** 审批决策 */
  decision: RuntimeToolDecision | null
  /** 开始时间 */
  startedAt: string | null
  /** 完成时间 */
  completedAt: string | null
  /** 错误信息 */
  errorMessage: string | null
  /** 指向完整 Canonical ToolResultPart 的本地 ID */
  resultPartId: string | null
}

/** Tool Call 创建参数 */
export interface CreateRuntimeToolCallInput {
  /** 工具调用 ID */
  id?: string
  /** 所属 turn ID */
  turnId: string
  /** assistant tool part ID */
  assistantPartId: string
  /** assistant transcript message ID */
  assistantMessageId: string
  /** Provider 原始工具调用 ID */
  providerCallId: string
  /** 工具名 */
  name: string
  /** 工具参数 */
  args: UnknownRecord
  /** 工具状态 */
  status?: RuntimeToolCallStatus
  /** 审批决策 */
  decision?: RuntimeToolDecision | null
  /** 开始时间 */
  startedAt?: string | null
}

/** Tool Call 更新参数 */
export interface UpdateRuntimeToolCallInput {
  /** 开始时间 */
  startedAt?: string | null
  /** 工具状态 */
  status?: RuntimeToolCallStatus
  /** 审批决策 */
  decision?: RuntimeToolDecision | null
  /** 完成时间 */
  completedAt?: string | null
  /** 错误信息 */
  errorMessage?: string | null
  /** 指向完整 Canonical ToolResultPart 的本地 ID */
  resultPartId?: string | null
}

/** Tool Call 仓储 */
export interface RuntimeToolCallRepository {
  /** 创建工具调用记录 */
  create: (input: CreateRuntimeToolCallInput) => Promise<RuntimeToolCallRecord>
  /** 更新工具调用记录 */
  update: (id: string, input: UpdateRuntimeToolCallInput) => Promise<RuntimeToolCallRecord>
  /** 列出线程或 turn 的工具调用 */
  list: (input: { threadId?: string, turnId?: string }) => Promise<RuntimeToolCallRecord[]>
}
