import type { BlobStore } from '@elmino/store'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import type { runtimeRelations } from '../schema/index.js'

/** -------------------- 类型 -------------------- */
/** Drizzle RuntimeStore 初始化参数 */
export interface DrizzleRuntimeStoreOptions {
  /** Drizzle 数据库实例 */
  db: RuntimeDrizzleDatabase
  /** artifact blob 存储 */
  blobStore: BlobStore
}

/** 根连接和事务共享完整 Drizzle 查询类型与关联定义 */
export type RuntimeDrizzleDatabase = NodeSQLiteDatabase<typeof runtimeRelations>
