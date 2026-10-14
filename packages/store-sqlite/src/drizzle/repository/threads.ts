import type { RuntimeThreadRepository } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { objectPick } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import dayjs from 'dayjs'
import { and, asc, count, desc, eq, isNotNull, isNull, notExists, sql } from 'drizzle-orm'
import { threadFromRow } from '../codec/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建线程元信息仓储，不拥有连接或事务生命周期
 */
export function createThreadRepository(db: RuntimeDrizzleDatabase): RuntimeThreadRepository {
  /**
   * 读取线程
   */
  const read = async (id: string) => {
    const [row] = await db.select().from(schema.threads).where(eq(schema.threads.id, id))

    return row && threadFromRow(row)
  }

  return {
    /**
     * 查询未归档主聊天，空关键词只读取最近会话，不访问正文
     */
    search: async (agentId, query, limit) => {
      const { threads, transcriptMessages, threadSpawnEdges } = schema
      const title = sql<string | null>`coalesce(
        nullif(${threads.user_title}, ''),
        nullif(${threads.auto_title}, '')
      )`
      // 用查询构造器保留关联列的限定名，避免 JSON 表函数的 id 与线程 id 冲突
      const body = db.select({ text: sql<string>`json_extract(part.value, '$.text')` })
        .from(transcriptMessages)
        .innerJoin(
          sql`json_each(cast(${transcriptMessages.content_blob} as text), '$.parts') as part`,
          sql`true`,
        )
        .where(and(
          eq(transcriptMessages.thread_id, threads.id),
          sql`json_extract(cast(${transcriptMessages.content_blob} as text), '$.role')
            in ('user', 'assistant')`,
          sql`json_extract(cast(${transcriptMessages.content_blob} as text), '$.kind') = 'normal'`,
          sql`json_extract(part.value, '$.type') = 'text'`,
          sql`instr(lower(json_extract(part.value, '$.text')), lower(${query})) > 0`,
        ))
        .orderBy(desc(transcriptMessages.seq), sql`cast(part.key as integer)`)
        .limit(1)
      // instr 按字面匹配，百分号、下划线和引号不改变查询语义
      const content = query.trim()
        ? sql<string | null>`case
        when instr(lower(${title}), lower(${query})) > 0 then ${title}
        else (${body}) end`
        : sql<string>`''`
      const matches = db.select({
        threadId: threads.id,
        title: title.as('title'),
        content: content.as('content'),
        lastInteractionAt: threads.last_interaction_at,
      }).from(threads).where(and(
        eq(threads.agent_id, agentId),
        eq(threads.lifecycle, 'active'),
        isNull(threads.archived_at),
        notExists(db.select().from(threadSpawnEdges)
          .where(eq(threadSpawnEdges.child_thread_id, threads.id))),
      )).as('matches')

      // 在数据库内裁剪片段，避免把大段历史正文传入 Server 与浏览器
      const rows = await db.select({
        threadId: matches.threadId,
        title: matches.title,
        snippet: sql<string>`substr(${matches.content},
          max(1, instr(lower(${matches.content}), lower(${query})) - 40), 240)`,
        lastInteractionAt: matches.lastInteractionAt,
      })
        .from(matches)
        .where(isNotNull(matches.content))
        .orderBy(desc(matches.lastInteractionAt), asc(matches.threadId))
        .limit(limit)
        .execute()

      return rows.map(({ title, ...hit }) => ({ ...hit, ...(title ? { title } : {}) }))
    },
    /**
     * 写入或更新线程稳定元信息
     */
    upsert: async (input) => {
      const table = schema.threads
      const current = await read(input.id)
      const now = input.updatedAt ?? dayjs().toISOString()
      const dir = input.dir ?? current?.dir
      const agentId = input.agentId ?? current?.agentId

      if (dir === undefined || agentId === undefined)
        throw new Error('创建线程需要指定目录和 Agent')

      const values = {
        id: input.id,
        dir,
        lifecycle: input.lifecycle ?? current?.lifecycle ?? 'active',
        agent_id: agentId,
        auto_title: input.autoTitle === undefined
          ? current?.autoTitle ?? null
          : normalizeNullableTitle(input.autoTitle),
        user_title: input.userTitle === undefined
          ? current?.userTitle ?? null
          : normalizeNullableTitle(input.userTitle),
        status: input.status ?? current?.status ?? 'idle',
        pinned: input.pinned ?? current?.pinned ?? false,
        unread_at: input.unreadAt === undefined
          ? current?.unreadAt ?? null
          : input.unreadAt,
        archived_at: input.archivedAt === undefined
          ? current?.archivedAt ?? null
          : input.archivedAt,
        created_at: current?.createdAt ?? input.createdAt ?? now,
        updated_at: now,
        last_interaction_at: input.lastInteractionAt ?? current?.lastInteractionAt ?? now,
        metadata_json: JSON.stringify(input.metadata ?? current?.metadata ?? {}),
        settings_json: JSON.stringify(input.settings ?? current?.settings ?? DEFAULT_THREAD_SETTINGS),
        state_json: JSON.stringify(input.state ?? current?.state ?? {}),
      }

      await db.insert(table)
        .values(values)
        .onConflictDoUpdate({
          target: table.id,
          set: objectPick(
            values,
            'agent_id',
            'dir',
            'lifecycle',
            'auto_title',
            'user_title',
            'status',
            'pinned',
            'unread_at',
            'archived_at',
            'updated_at',
            'last_interaction_at',
            'metadata_json',
            'settings_json',
            'state_json',
          ),
        })

      return (await read(input.id))!
    },
    /**
     * 原子归档全部未归档根线程
     */
    archiveAll: async (archivedAt) => {
      const { threadSpawnEdges, threads } = schema
      const rows = await db.update(threads)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(and(
          eq(threads.lifecycle, 'active'),
          isNull(threads.archived_at),
          notExists(
            db.select()
              .from(threadSpawnEdges)
              .where(eq(threadSpawnEdges.child_thread_id, threads.id)),
          ),
        ))
        .returning()

      return rows.map(threadFromRow)
    },
    read,
    /**
     * 列出全部线程
     */
    listAll: async () => {
      const rows = await db.select()
        .from(schema.threads)
        .orderBy(
          desc(schema.threads.last_interaction_at),
          desc(schema.threads.updated_at),
        )

      return rows.map(threadFromRow)
    },
    /**
     * 分页读取根线程稳定前缀和运行中集合
     */
    page: async (input) => {
      const { threadSpawnEdges, threads } = schema
      const rootCondition = isNull(threadSpawnEdges.child_thread_id)
      const archivedCondition = input.archived
        ? isNotNull(threads.archived_at)
        : isNull(threads.archived_at)
      const agentCondition = input.agentId
        ? eq(threads.agent_id, input.agentId)
        : undefined
      const pageCondition = and(
        archivedCondition,
        rootCondition,
        agentCondition,
        eq(threads.lifecycle, 'active'),
      )
      const query = db.select({ thread: threads })
        .from(threads)
        .leftJoin(
          threadSpawnEdges,
          eq(threadSpawnEdges.child_thread_id, threads.id),
        )
        .where(pageCondition)
      const rowsPromise = input.archived
        ? query
            .orderBy(desc(threads.archived_at), desc(threads.id))
            .limit(input.limit + 1)
        : query
            .orderBy(
              desc(threads.pinned),
              desc(threads.last_interaction_at),
              desc(threads.updated_at),
              desc(threads.id),
            )
            .limit(input.limit + 1)
      const runningRowsPromise = input.archived
        ? Promise.resolve([])
        : db.select({ id: threads.id })
            .from(threads)
            .leftJoin(
              threadSpawnEdges,
              eq(threadSpawnEdges.child_thread_id, threads.id),
            )
            .where(and(
              isNull(threads.archived_at),
              eq(threads.status, 'running'),
              eq(threads.lifecycle, 'active'),
              rootCondition,
              agentCondition,
            ))
            .orderBy(desc(threads.id))
      const summaryRowsPromise = db.select({
        total: count(),
        unread: count(threads.unread_at),
      })
        .from(threads)
        .leftJoin(
          threadSpawnEdges,
          eq(threadSpawnEdges.child_thread_id, threads.id),
        )
        .where(pageCondition)
      const [rows, runningRows, [summary]] = await Promise.all([
        rowsPromise,
        runningRowsPromise,
        summaryRowsPromise,
      ])

      return {
        items: rows.slice(0, input.limit).map(row => (
          threadFromRow(row.thread)
        )),
        hasMore: rows.length > input.limit,
        runningThreadIds: runningRows.map(row => row.id),
        summary: {
          total: summary?.total ?? 0,
          unread: summary?.unread ?? 0,
        },
      }
    },
    /**
     * 仅在线程仍处于预期生命周期时切换状态
     */
    transitionLifecycle: async (id, from, to) => {
      const [row] = await db.update(schema.threads)
        .set({ lifecycle: to, updated_at: dayjs().toISOString() })
        .where(and(
          eq(schema.threads.id, id),
          eq(schema.threads.lifecycle, from),
        ))
        .returning()

      return row && threadFromRow(row)
    },
    /** 删除线程并等待关联记录完成级联删除 */
    remove: async (id) => {
      await db.delete(schema.threads).where(eq(schema.threads.id, id))
    },
  }
}

/**
 * 归一化可空标题
 */
function normalizeNullableTitle(title: string | null) {
  return title || null
}
