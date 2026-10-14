import type { RuntimeStoreTx } from '@elmino/store'
import type { DrizzleRuntimeStoreOptions } from '../types/index.js'
import {
  createArtifactRepository,
  createCanonicalRepository,
  createSpawnRepositories,
  createStepRepository,
  createThreadRepository,
  createToolCallRepository,
  createTranscriptRepository,
  createTurnRepository,
} from '../repository/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 将同一连接的领域仓储装配成 RuntimeStore 事务视图
 */
export function createDrizzleRuntimeStore({ db, blobStore }: DrizzleRuntimeStoreOptions): RuntimeStoreTx {
  return {
    threads: createThreadRepository(db),
    canonical: createCanonicalRepository(db),
    transcript: createTranscriptRepository(db),
    turns: createTurnRepository(db),
    steps: createStepRepository(db),
    toolCalls: createToolCallRepository(db),
    artifacts: createArtifactRepository({ db, blobStore }),
    ...createSpawnRepositories(db),
  }
}
