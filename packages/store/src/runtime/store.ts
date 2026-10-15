import type { Except } from '@elmino/shared'
import type { RuntimeArtifactRepository } from './artifact'
import type { RuntimeCanonicalRepository } from './canonical'
import type { RuntimeThreadSpawnEdgeRepository, RuntimeTurnSpawnEdgeRepository } from './spawn'
import type { RuntimeStepRepository } from './step'
import type { RuntimeThreadRepository } from './thread'
import type { RuntimeToolCallRepository } from './tool'
import type { RuntimeTranscriptRepository } from './transcript'
import type { RuntimeTurnRepository } from './turn'

/** -------------------- 类型 -------------------- */
/** 事务内 RuntimeStore 视图 */
export type RuntimeStoreTx = Except<RuntimeStore, 'close' | 'transaction'>

/** 配置适配器借出的存储作用域，只能通过 release 释放其持有权 */
export interface RuntimeStoreLease {
  /** 本次调用可使用的存储，不直接关闭共享实例 */
  store: RuntimeStore
  /** 等待本次调用结束后释放；重复调用共享同一释放结果 */
  release: () => Promise<void>
}

/** 延迟打开存储配置；共享、引用计数与最终关闭由具体适配器管理 */
export type RuntimeStoreProvider = (signal?: AbortSignal) => Promise<RuntimeStoreLease>

/** 统一运行时存储接口 */
export interface RuntimeStore {
  /** 线程仓储 */
  threads: RuntimeThreadRepository
  /** 持久化 transcript 仓储 */
  transcript: RuntimeTranscriptRepository
  /** Canonical Message/Part 仓储 */
  canonical: RuntimeCanonicalRepository
  /** Turn 仓储 */
  turns: RuntimeTurnRepository
  /** Step 事实仓储 */
  steps: RuntimeStepRepository
  /** Tool Call 仓储 */
  toolCalls: RuntimeToolCallRepository
  /** 子线程关系仓储 */
  spawnEdges: RuntimeThreadSpawnEdgeRepository
  /** 子线程 Turn 关系仓储 */
  turnSpawnEdges: RuntimeTurnSpawnEdgeRepository
  /** Artifact 仓储 */
  artifacts: RuntimeArtifactRepository
  /** 原子提交或回滚仓储写入；事务视图只在回调内有效，不回滚外部 blob 写入 */
  transaction: <T>(fn: (tx: RuntimeStoreTx) => Promise<T>) => Promise<T>
  /** 等待已接纳操作结束并关闭；重复关闭幂等，关闭后拒绝新操作 */
  close: () => Promise<void>
}
