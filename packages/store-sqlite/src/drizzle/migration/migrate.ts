import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'

/** -------------------- 常量 -------------------- */
/** RuntimeStore 版本化迁移目录 */
const migrationsFolder = fileURLToPath(
  new URL('../../../drizzle/runtime/migrations', import.meta.url),
)

/** -------------------- 核心函数 -------------------- */
/**
 * 应用 RuntimeStore 尚未执行的 Drizzle 迁移
 */
export function migrateRuntimeStore(
  db: NodeSQLiteDatabase,
) {
  db.run(sql`PRAGMA foreign_keys = ON`)
  migrate(db, { migrationsFolder })
}
