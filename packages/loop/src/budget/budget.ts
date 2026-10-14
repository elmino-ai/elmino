import type { ThreadContextBudget, ThreadContextBudgetEstimation } from '@elmino/thread'
import dayjs from 'dayjs'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建空上下文预算占位
 */
export function createEmptyContextBudget(maxTokens: number): ThreadContextBudget {
  return createContextBudget(0, 0, maxTokens, 'approximate')
}

/**
 * 根据当前上下文占用创建预算投影
 */
export function createContextBudget(
  inputUsedTokens: number,
  inputMessageCount: number,
  maxTokens: number,
  estimation: ThreadContextBudgetEstimation,
): ThreadContextBudget {
  const usedTokens = nonNegativeInteger(inputUsedTokens)
  const remainingTokens = Math.max(maxTokens - usedTokens, 0)
  const messageCount = nonNegativeInteger(inputMessageCount)
  const updatedAt = dayjs().toISOString()

  return {
    usedTokens,
    maxTokens,
    remainingTokens,
    messageCount,
    estimation,
    updatedAt,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 读取非负整数
 */
function nonNegativeInteger(value: unknown) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    ? Math.floor(value)
    : 0
}
