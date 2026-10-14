import type {
  AppendRuntimeCanonicalMessageInput,
  RuntimeCanonicalMessageRecord,
  RuntimeCanonicalPartMetadataRecord,
  RuntimeCanonicalPartRecord,
  RuntimeCanonicalRepository,
} from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { Buffer } from 'node:buffer'
import { createId } from '@elmino/shared'
import dayjs from 'dayjs'
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { readJsonObject } from '../codec/index.js'
import { nextSeq } from '../query/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 类型与常量 -------------------- */
/** readContext 单页最大 JSON 字符数 */
const CANONICAL_PART_PAGE_MAX_LENGTH = 50 * 1024

/** Drizzle 查询行 */
type CanonicalPartRow = typeof schema.canonicalParts.$inferSelect

/** -------------------- 核心函数 -------------------- */
/**
 * 创建不可变消息与正文仓储，不拥有连接或事务生命周期
 */
export function createCanonicalRepository(db: RuntimeDrizzleDatabase): RuntimeCanonicalRepository {
  /**
   * 读取单条完整 Canonical Message
   */
  const readMessage = async (threadId: string, id: string) => {
    // 完整消息与 Parts 在同一条 SQL 中读取，事务实例也沿用自己的查询连接
    const row = await db.query.canonicalMessages.findFirst({
      where: { thread_id: threadId, id },
      with: { parts: { orderBy: { seq: 'asc' } } },
    })

    if (!row)
      return

    return {
      ...canonicalMessageFromRow(row),
      parts: row.parts.map(canonicalPartFromRow),
    }
  }

  /**
   * 追加单条不可变 Canonical Message 及其完整 Part BLOB
   */
  const append = async (input: AppendRuntimeCanonicalMessageInput) => {
    // 1. 在调用方持有的事务中分配线程顺序并写入消息元信息
    const table = schema.canonicalMessages
    const createdAt = input.createdAt ?? dayjs().toISOString()
    const id = input.id ?? createId('canonical_message')
    const seq = input.seq ?? await nextSeq(db, table, input.threadId)

    await db.insert(table).values({
      id,
      thread_id: input.threadId,
      turn_id: input.turnId,
      seq,
      role: input.role,
      provider_id: input.providerId ?? null,
      finish_reason: input.finishReason ?? null,
      raw_finish_reason: input.rawFinishReason ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      created_at: createdAt,
    })

    // 2. 正文与消息共享同一事务，任一 Part 写入失败都会回滚完整消息
    for (const [index, part] of input.parts.entries()) {
      const content = Buffer.from(JSON.stringify(part.content), 'utf8')

      await db.insert(schema.canonicalParts).values({
        id: part.id ?? createId('canonical_part'),
        message_id: id,
        seq: index + 1,
        type: part.type,
        size_bytes: content.byteLength,
        content_blob: content,
        created_at: createdAt,
      })
    }

    // 3. 从事务视图返回完整消息，外部读取只能在提交后看到它
    return (await readMessage(input.threadId, id))!
  }

  return {
    append,
    /**
     * 按输入顺序追加多条不可变 Canonical Message
     */
    appendMany: async (inputs) => {
      const records = []

      for (const input of inputs)
        records.push(await append(input))

      return records
    },

    /**
     * 按线程顺序读取 Canonical Message 元数据
     */
    list: async (threadId, input = {}) => {
      const table = schema.canonicalMessages
      const conditions = [eq(table.thread_id, threadId)]

      if (input.afterSeq !== undefined)
        conditions.push(gt(table.seq, input.afterSeq))
      if (input.throughSeq !== undefined)
        conditions.push(lte(table.seq, input.throughSeq))

      const rows = await db.select()
        .from(table)
        .where(and(...conditions))
        .orderBy(asc(table.seq))

      return rows.map(canonicalMessageFromRow)
    },

    /**
     * 读取 Canonical Part 元数据但不加载正文 BLOB
     */
    listParts: async (threadId, input = {}) => {
      const messageTable = schema.canonicalMessages
      const partTable = schema.canonicalParts
      const conditions = [eq(messageTable.thread_id, threadId)]

      if (input.afterSeq !== undefined)
        conditions.push(gt(messageTable.seq, input.afterSeq))
      if (input.throughSeq !== undefined)
        conditions.push(lte(messageTable.seq, input.throughSeq))

      const rows = await db.select({ part: {
        id: partTable.id,
        message_id: partTable.message_id,
        seq: partTable.seq,
        type: partTable.type,
        size_bytes: partTable.size_bytes,
        created_at: partTable.created_at,
      } })
        .from(partTable)
        .innerJoin(messageTable, eq(partTable.message_id, messageTable.id))
        .where(and(...conditions))
        .orderBy(asc(messageTable.seq), asc(partTable.seq))

      return rows.map(row => (
        canonicalPartMetadataFromRow(row.part)
      ))
    },
    readMessage,
    /**
     * 读取当前线程拥有的单条完整 Canonical Part
     */
    readPart: async (threadId, id) => {
      const row = await db.query.canonicalParts.findFirst({
        where: { id, message: { thread_id: threadId } },
      })

      return row && canonicalPartFromRow(row)
    },

    /**
     * 批量读取当前线程拥有的 Canonical Part BLOB
     */
    readParts: async (threadId, ids) => {
      if (ids.length === 0)
        return []

      const messageTable = schema.canonicalMessages
      const partTable = schema.canonicalParts
      const rows = await db.select({ part: partTable })
        .from(partTable)
        .innerJoin(messageTable, eq(partTable.message_id, messageTable.id))
        .where(and(
          eq(messageTable.thread_id, threadId),
          inArray(partTable.id, ids),
        ))
        .orderBy(asc(messageTable.seq), asc(partTable.seq))

      return rows.map(row => (
        canonicalPartFromRow(row.part)
      ))
    },

    /**
     * 让 SQLite 直接截取 Canonical Part BLOB，避免先把超大正文全部加载到进程
     */
    readPartPage: async (threadId, id, options = {}) => {
      const messageTable = schema.canonicalMessages
      const partTable = schema.canonicalParts
      const offset = Math.max(0, Math.floor(options.offset ?? 0))
      const limit = Math.min(
        CANONICAL_PART_PAGE_MAX_LENGTH,
        Math.max(1, Math.floor(options.limit ?? CANONICAL_PART_PAGE_MAX_LENGTH)),
      )
      const [row] = await db.select({
        id: partTable.id,
        messageId: partTable.message_id,
        type: partTable.type,
        sizeBytes: partTable.size_bytes,
        content: sql<string>`CAST(substr(CAST(${partTable.content_blob} AS TEXT), ${offset + 1}, ${limit}) AS TEXT)`,
        totalLength: sql<number>`length(CAST(${partTable.content_blob} AS TEXT))`,
      })
        .from(partTable)
        .innerJoin(messageTable, eq(partTable.message_id, messageTable.id))
        .where(and(eq(messageTable.thread_id, threadId), eq(partTable.id, id)))

      if (!row)
        return

      const totalLength = Number(row.totalLength)
      const nextOffset = Math.min(offset + limit, totalLength)

      return {
        id: row.id,
        messageId: row.messageId,
        type: row.type,
        offset,
        content: row.content,
        ...(nextOffset < totalLength ? { nextOffset } : {}),
        totalLength,
        sizeBytes: row.sizeBytes,
      }
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将 canonical message 行映射为不可变元数据
 */
function canonicalMessageFromRow(row: typeof schema.canonicalMessages.$inferSelect): RuntimeCanonicalMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    seq: row.seq,
    role: row.role,
    providerId: row.provider_id,
    finishReason: row.finish_reason,
    rawFinishReason: row.raw_finish_reason,
    metadata: readJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }
}

/**
 * 将 canonical part 行映射为不含正文的元数据
 */
function canonicalPartMetadataFromRow(
  row: Omit<CanonicalPartRow, 'content_blob'>,
): RuntimeCanonicalPartMetadataRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    seq: row.seq,
    type: row.type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }
}

/**
 * 将 canonical part BLOB 无损解析为 Part JSON
 */
function canonicalPartFromRow(
  row: CanonicalPartRow,
): RuntimeCanonicalPartRecord {
  const content = Buffer.isBuffer(row.content_blob)
    ? row.content_blob.toString('utf8')
    : Buffer.from(row.content_blob).toString('utf8')

  return {
    ...canonicalPartMetadataFromRow(row),
    content: readJsonObject(content),
  }
}
