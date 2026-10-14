import type { Message, ModelTurnConfig } from '@elmino/llm'
import type { ThreadContextBudget, ThreadSnapshotRecord } from '@elmino/thread'
import type { PromptContextSection } from '../../hooks/index'
import type { RecoveryStatus } from '../../recovery/index'
import { createEmptyContextBudget } from '../../budget/index'
import { createRecoveryStatus } from '../../recovery/index'

/** -------------------- 类型 -------------------- */
/** Loop 跨 Step 保留的可变状态 */
export interface TurnState {
  /** 当前模型上下文消息 */
  contextMessages: Message[]
  /** 当前上下文预算 */
  contextBudget: ThreadContextBudget
  /** 错误恢复相关状态 */
  recovery: RecoveryStatus
  /** 本执行切片首次解析后冻结的稳定系统上下文 */
  stablePromptContext?: PromptContextSection[]
}

/** -------------------- 核心函数 -------------------- */
/**
 * 从线程快照和本轮输入创建 Loop Turn 状态
 */
export function createTurnState(input: {
  /** 当前模型 token 限制 */
  limit: ModelTurnConfig['limit']
  /** 已存在的线程快照 */
  threadSnapshot?: ThreadSnapshotRecord
  /** 从 Canonical 历史重建的初始上下文 */
  contextMessages: Message[]
}): TurnState {
  return {
    contextMessages: input.contextMessages,
    contextBudget: input.threadSnapshot?.contextBudget
      ?? createEmptyContextBudget(input.limit.context),
    recovery: createRecoveryStatus(),
  }
}
