import type { RuntimeTranscriptRepository, ThreadMessage } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { Buffer } from 'node:buffer'
import { jsonParse } from '@elmino/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { nextSeq } from '../query/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建界面消息投影仓储，不拥有连接或事务生命周期
 */
export function createTranscriptRepository(db: RuntimeDrizzleDatabase): RuntimeTranscriptRepository {
  /**
   * 读取 UI transcript 原始行以保留首次写入顺序
   */
  const readRow = async (id: string) => {
    const table = schema.transcriptMessages
    const [row] = await db.select().from(table).where(eq(table.id, id))

    return row
  }

  return {
    /**
     * 以稳定顺序创建或更新完整 UI 消息投影
     */
    upsert: async (message) => {
      const table = schema.transcriptMessages
      const current = await readRow(message.id)
      const content = Buffer.from(JSON.stringify(message), 'utf8')

      if (current) {
        if (
          current.thread_id !== message.threadId
          || current.turn_id !== message.turnId
        ) {
          throw new Error(`Transcript 消息归属不可变更: ${message.id}`)
        }

        await db.update(table)
          .set({ content_blob: content })
          .where(eq(table.id, message.id))
      }
      else {
        const seq = await nextSeq(db, table, message.threadId)

        await db.insert(table).values({
          id: message.id,
          thread_id: message.threadId,
          turn_id: message.turnId,
          seq,
          content_blob: content,
        })
      }

      return message
    },

    /**
     * 按 ID 读取完整 UI 消息投影
     */
    read: async (id) => {
      const row = await readRow(id)

      return row && transcriptMessageFromRow(row)
    },

    /**
     * 按线程稳定顺序列出 UI 消息投影
     */
    list: async (threadId, turnIds) => {
      if (turnIds?.length === 0)
        return []

      const table = schema.transcriptMessages
      const conditions = [eq(table.thread_id, threadId)]

      if (turnIds)
        conditions.push(inArray(table.turn_id, turnIds))

      const rows = await db.select()
        .from(table)
        .where(and(...conditions))
        .orderBy(asc(table.seq))

      return rows.map(transcriptMessageFromRow)
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 从单行 BLOB 还原完整 UI transcript 消息
 */
function transcriptMessageFromRow(row: typeof schema.transcriptMessages.$inferSelect): ThreadMessage {
  const content = Buffer.isBuffer(row.content_blob)
    ? row.content_blob.toString('utf8')
    : Buffer.from(row.content_blob).toString('utf8')
  const message = jsonParse<ThreadMessage>(content, {} as ThreadMessage)

  if (
    message.id !== row.id
    || message.threadId !== row.thread_id
    || message.turnId !== row.turn_id
  ) {
    throw new Error(`Transcript 消息归属损坏: ${row.id}`)
  }

  return message
}
