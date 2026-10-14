import type { RuntimeStore } from '@elmino/store'
import type { ThreadContextBudget, ThreadInterrupt, ThreadSnapshotUpdate } from '@elmino/thread'
import type { ContextProjection } from '../../context-projection/index.js'
import type { ExecutionHooks } from '../../hooks/index.js'
import type { TurnContext, TurnOutcome, TurnOutcomeStatus, TurnRuntimeEventEmitter } from '../types/index.js'
import type { TurnState } from './state.js'
import { createId } from '@elmino/shared'
import { updateThreadSnapshot } from '@elmino/thread'
import dayjs from 'dayjs'

/** -------------------- 类型 -------------------- */
/** Turn 终态快照附加信息 */
interface TurnSnapshotOptions {
  /** 需要后续恢复的中断载荷 */
  interrupt?: ThreadInterrupt
  /** 不可恢复失败原因 */
  errorMessage?: string
}

/** 单次 Loop Turn 的快照能力 */
export interface TurnSnapshots {
  /** 物化当前上下文和扩展状态，供调用方组合事务 */
  materialize: (
    status?: TurnOutcomeStatus,
    options?: TurnSnapshotOptions,
  ) => Promise<ThreadSnapshotUpdate>
  /** 发布当前线程上下文预算 */
  publishBudget: () => Promise<ThreadContextBudget>
  /** 保存运行中的消息和上下文预算 */
  saveProgress: () => Promise<void>
  /** 保存完整 thread snapshot 并记录本轮终态 */
  saveOutcome: (
    status: TurnOutcomeStatus,
    options?: TurnSnapshotOptions,
  ) => Promise<void>
  /** 读取 Loop 已经固定的终态事实 */
  readOutcome: () => TurnOutcome
}

/** -------------------- 核心函数 -------------------- */
/**
 * 创建 Loop 运行中的 Thread snapshot 能力
 */
export function createTurnSnapshots(
  input: {
    /** 当前 Turn 引用 */
    turn: { turnId: string, threadId: string }
    /** 结构化运行事件输出 */
    emitRuntime: TurnRuntimeEventEmitter
    /** 最近交互时间 */
    lastInteractionAt: string
    /** 当前 Turn 冻结的调用上下文 */
    context: TurnContext
    /** 当前 Turn 直接执行扩展 */
    hooks: ExecutionHooks
    /** 当前 Turn 跨 Step 保留的可变状态 */
    state: TurnState
    /** 当前 Turn Canonical Context 投影器 */
    projection: ContextProjection
    /** 结构化事实存储 */
    store: RuntimeStore
  },
): TurnSnapshots {
  const {
    emitRuntime,
    lastInteractionAt,
    turn,
    state,
    projection,
    context,
    hooks,
    store,
  } = input
  const { turnId, threadId } = turn
  let outcome!: TurnOutcome

  /** 创建当前 Turn 的系统级中断信息 */
  const createSystemInterrupt = (createdAt: string): ThreadInterrupt => ({
    id: createId('interrupt'),
    kind: 'system',
    status: 'pending',
    turnId,
    reason: '运行被中断',
    createdAt,
    resumableWith: ['message'],
  })

  /** 广播当前上下文预算 */
  const publishBudget = async () => {
    const { contextBudget } = state

    await emitRuntime('context.budget', contextBudget)

    return contextBudget
  }

  /** 提取当前 Loop 状态中唯一需要持久化的恢复上下文 */
  const materialize = async (
    status?: TurnOutcomeStatus,
    options?: TurnSnapshotOptions,
  ): Promise<ThreadSnapshotUpdate> => {
    if (status) {
      await hooks.beforeSnapshot?.({ context, status })

      const now = dayjs().toISOString()
      const interrupt = status === 'interrupted'
        ? options?.interrupt
        ?? createSystemInterrupt(now)
        : undefined

      outcome = {
        status,
        interrupt,
        errorMessage: options?.errorMessage,
      }
    }

    const { contextBudget } = state
    const extensionStatePatch = await hooks.collectState?.(context)
    const contextProjection = projection.readState()

    return {
      extensionStatePatch,
      contextProjection,
      contextBudget,
      lastInteractionAt,
    }
  }

  return {
    materialize,
    publishBudget,
    saveProgress: async () => {
      await updateThreadSnapshot(
        store,
        threadId,
        await materialize(),
      )
      await publishBudget()
    },
    saveOutcome: async (status, options) => {
      await updateThreadSnapshot(
        store,
        threadId,
        await materialize(status, options),
      )
      await publishBudget()
    },
    readOutcome: () => outcome,
  }
}
