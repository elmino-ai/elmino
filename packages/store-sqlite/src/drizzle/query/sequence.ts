import type * as schema from '../schema/index.js'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { eq, sql } from 'drizzle-orm'

/** -------------------- 核心函数 -------------------- */
/**
 * 计算聚合范围内下一个 seq
 */
export async function nextSeq(
  db: RuntimeDrizzleDatabase,
  table: typeof schema.canonicalMessages | typeof schema.transcriptMessages,
  threadId: string,
) {
  const [row] = await db.select({
    seq: sql<number>`COALESCE(MAX(${table.seq}), 0) + 1`,
  }).from(table).where(eq(table.thread_id, threadId))

  return Number(row?.seq ?? 1)
}
