import type { Except } from '@elmino/shared'
import type { RuntimeArtifactRepository } from './artifact.js'
import type { RuntimeCanonicalRepository } from './canonical.js'
import type { RuntimeThreadSpawnEdgeRepository, RuntimeTurnSpawnEdgeRepository } from './spawn.js'
import type { RuntimeStepRepository } from './step.js'
import type { RuntimeThreadRepository } from './thread.js'
import type { RuntimeToolCallRepository } from './tool.js'
import type { RuntimeTranscriptRepository } from './transcript.js'
import type { RuntimeTurnRepository } from './turn.js'

/** -------------------- 类型 -------------------- */
/** 事务内 RuntimeStore 视图 */
export type RuntimeStoreTx = Except<RuntimeStore, 'close' | 'transaction'>

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
