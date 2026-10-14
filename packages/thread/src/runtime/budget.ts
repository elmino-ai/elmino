import type { ThreadTokenUsage } from '@elmino/store'

/** -------------------- 类型 -------------------- */
/** 线程及其完整任务的 token 用量投影 */
export interface ThreadUsagePayload {
  /** 当前线程自身用量 */
  usage: ThreadTokenUsage
  /** 当前线程及所有派生子线程的累计用量 */
  taskUsage: ThreadTokenUsage
}

/** 线程上下文占用估算来源 */
export type ThreadContextBudgetEstimation = 'approximate' | 'provider'

/** 线程上下文预算 */
export interface ThreadContextBudget {
  /** 最近一次上下文窗口占用 token 数 */
  usedTokens: number
  /** 当前模型上下文窗口预算 */
  maxTokens: number
  /** 剩余上下文 token 数 */
  remainingTokens: number
  /** 当前上下文消息数 */
  messageCount: number
  /** 上下文占用来源 */
  estimation: ThreadContextBudgetEstimation
  /** 最近更新时间 */
  updatedAt: string
}
