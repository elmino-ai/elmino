import type { ThreadCommitter } from '@elmino/thread'
import type { DefinedTools, ToolExecutionContext } from '@elmino/tool'
import type { ContextProjection } from '../../context-projection/index'
import type { ExecutionHooks } from '../../hooks/index'
import type { TurnContext, TurnRuntimeEventEmitter } from '../types/index'
import type { TurnSnapshots } from './snapshot'
import type { TurnState } from './state'

/** -------------------- 类型 -------------------- */
/** Turn 启动后持有的稳定能力与可变状态 */
export interface ActiveTurn {
  /** Turn 内共享的完整调用上下文 */
  readonly context: TurnContext
  /** 结构化运行事件输出 */
  readonly emitRuntime: TurnRuntimeEventEmitter
  /** 当前 Turn Canonical Context 投影器 */
  readonly projection: ContextProjection
  /** 当前 Turn 的单一持久提交边界 */
  readonly committer: ThreadCommitter
  /** 当前 Turn 的 Thread snapshot 能力 */
  readonly snapshots: TurnSnapshots
  /** 当前 Turn 跨 Step 保留的可变状态 */
  readonly state: TurnState
  /** 当前 Turn 直接执行扩展 */
  readonly hooks: ExecutionHooks
  /** 当前 Turn 冻结的工具声明与处理器 */
  readonly tools: DefinedTools
  /** 当前 Turn 工具执行能力 */
  readonly toolContext: ToolExecutionContext
  /** 释放当前 Turn 持有的资源 */
  readonly dispose: () => Promise<void>
}
