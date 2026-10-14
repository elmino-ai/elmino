import type { ExcludeStrict } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** Step 状态 */
export type RuntimeStepStatus
  = | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'

/** Provider sampling Step 事实 */
export interface RuntimeStepRecord {
  /** Step ID */
  id: string
  /** 所属 Turn ID */
  turnId: string
  /** Step 状态 */
  status: RuntimeStepStatus
  /** 普通输入 token 数 */
  input: number
  /** 输出 token 数 */
  output: number
  /** 输出中用于推理的 token 数 */
  reasoning: number
  /** 写入 prompt cache 的 token 数 */
  cacheWrite: number
  /** 命中 prompt cache 的 token 数 */
  cacheRead: number
  /** 由本地估算补齐的 token 数 */
  estimated: number
  /** 创建时间 */
  createdAt: string
  /** 结束时间 */
  endedAt?: string
}

/** Step 创建参数 */
export interface CreateRuntimeStepInput {
  /** Step ID */
  id?: string
  /** 所属 Turn ID */
  turnId: string
  /** 调用前估算的普通输入 token 数 */
  input: number
  /** 调用前估算 token 数 */
  estimated: number
  /** 创建时间 */
  createdAt?: string
}

/** Step 终态参数 */
export interface SettleRuntimeStepInput {
  /** Step 终态 */
  status: ExcludeStrict<RuntimeStepStatus, 'running'>
  /** 普通输入 token 数 */
  input: number
  /** 输出 token 数 */
  output: number
  /** 输出中用于推理的 token 数 */
  reasoning: number
  /** 写入 prompt cache 的 token 数 */
  cacheWrite: number
  /** 命中 prompt cache 的 token 数 */
  cacheRead: number
  /** 由本地估算补齐的 token 数 */
  estimated: number
  /** 结束时间 */
  endedAt?: string
}

/** Step 仓储 */
export interface RuntimeStepRepository {
  /** 创建 running Step 事实 */
  create: (
    input: CreateRuntimeStepInput,
  ) => Promise<RuntimeStepRecord>
  /** 仅结算仍处于 running 的 Step 事实 */
  settle: (
    id: string,
    input: SettleRuntimeStepInput,
  ) => Promise<RuntimeStepRecord | undefined>
  /** 列出指定 Turn 的 Step 事实 */
  list: (turnId: string) => Promise<RuntimeStepRecord[]>
}
