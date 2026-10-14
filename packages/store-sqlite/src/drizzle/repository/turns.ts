import type { UnknownRecord } from '@elmino/shared'
import type { RuntimeTurnRecord, RuntimeTurnRepository, UpdateRuntimeTurnInput } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { createId, jsonParse } from '@elmino/shared'
import { createTokenUsage } from '@elmino/store'
import dayjs from 'dayjs'
import { and, asc, desc, eq, gt, inArray, lt, notExists, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { turnFromRow } from '../codec/index.js'
import { readTurnUsage, STEP_USAGE_SELECTION } from '../query/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建Turn 执行事实仓储，不拥有连接或事务生命周期
 */
export function createTurnRepository(db: RuntimeDrizzleDatabase): RuntimeTurnRepository {
  /**
   * 读取 turn
   */
  const read = async (id: string) => {
    const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, id))

    if (!row)
      return

    const usageByTurn = await readTurnUsage(db, [id])

    return turnFromRow(row, usageByTurn.get(id) ?? createTokenUsage())
  }

  /**
   * 合并 turn 更新并补齐状态切换时间
   */
  const nextTurn = (current: RuntimeTurnRecord, input: UpdateRuntimeTurnInput): RuntimeTurnRecord => {
    const now = dayjs()
    const status = input.status ?? current.status
    const isStarting = status === 'running' && current.status !== 'running'

    return {
      ...current,
      status,
      updatedAt: now.isAfter(current.updatedAt)
        ? now.toISOString()
        : dayjs(current.updatedAt).add(1, 'millisecond').toISOString(),
      startedAt: input.startedAt ?? current.startedAt ?? (
        isStarting ? dayjs().toISOString() : undefined
      ),
      endedAt: status === 'running'
        ? undefined
        : input.endedAt ?? current.endedAt,
      errorMessage: 'errorMessage' in input
        ? input.errorMessage ?? null
        : current.errorMessage,
      interrupt: 'interrupt' in input ? input.interrupt ?? null : current.interrupt,
    }
  }

  /**
   * 将 turn 领域记录映射成 Drizzle 更新字段
   */
  const values = (turn: RuntimeTurnRecord) => {
    return {
      status: turn.status,
      updated_at: turn.updatedAt,
      started_at: turn.startedAt ?? null,
      ended_at: turn.endedAt ?? null,
      error_message: turn.errorMessage,
      interrupt_json: turn.interrupt === null ? null : JSON.stringify(turn.interrupt),
    }
  }

  /**
   * 更新 turn
   */
  const update = async (id: string, input: UpdateRuntimeTurnInput) => {
    const current = (await read(id))!
    const next = nextTurn(current, input)

    await db.update(schema.turns)
      .set(values(next))
      .where(eq(schema.turns.id, id))

    return (await read(id))!
  }

  return {
    /**
     * 创建 turn
     */
    create: async (input) => {
      const id = input.id ?? createId('turn')
      const status = input.status ?? 'running'
      const createdAt = input.createdAt ?? dayjs().toISOString()
      const startedAt = input.startedAt ?? (
        status === 'queued' || status === 'cancelled'
          ? undefined
          : createdAt
      )

      await db.insert(schema.turns).values({
        id,
        thread_id: input.threadId,
        status,
        model_config_json: JSON.stringify(input.modelConfig),
        subagent_role_json: JSON.stringify(input.subagentRole),
        subagent_roles_json: JSON.stringify(input.subagentRoles),
        agent_snapshot_json: JSON.stringify(input.agentSnapshot),
        approval_mode: input.approvalMode,
        subagent_mode: input.subagentMode,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: startedAt ?? null,
        ended_at: null,
        error_message: null,
        interrupt_json: null,
      })

      return (await read(id))!
    },
    read,
    update,
    /**
     * 使用数据库条件更新保护 turn 终态不被迟到回调覆盖
     */
    transition: async (id, from, input) => {
      const current = await read(id)

      if (!current || !from.includes(current.status))
        return

      const [row] = await db.update(schema.turns)
        .set(values(nextTurn(current, input)))
        .where(and(
          eq(schema.turns.id, id),
          inArray(schema.turns.status, from),
        ))
        .returning()

      if (!row)
        return

      const usageByTurn = await readTurnUsage(db, [id])

      return turnFromRow(row, usageByTurn.get(id) ?? createTokenUsage())
    },
    /**
     * 列出线程 turn
     */
    list: async (threadId) => {
      const rows = await db.select()
        .from(schema.turns)
        .where(eq(schema.turns.thread_id, threadId))
        .orderBy(
          asc(schema.turns.created_at),
          asc(schema.turns.id),
        )

      const usageByTurn = await readTurnUsage(db, rows.map(row => row.id))

      return rows.map(row => turnFromRow(
        row,
        usageByTurn.get(row.id) ?? createTokenUsage(),
      ))
    },
    /**
     * 列出全部 turn
     */
    listAll: async () => {
      const rows = await db.select()
        .from(schema.turns)
        .orderBy(
          asc(schema.turns.thread_id),
          asc(schema.turns.created_at),
          asc(schema.turns.id),
        )

      const usageByTurn = await readTurnUsage(db, rows.map(row => row.id))

      return rows.map(row => turnFromRow(
        row,
        usageByTurn.get(row.id) ?? createTokenUsage(),
      ))
    },
    /**
     * 按 Turn keyset 分页读取执行事实
     */
    page: async (input) => {
      const { cursor, limit, threadId } = input
      const { turns } = schema
      const cursorWhere = cursor
        ? or(
            lt(turns.created_at, cursor.createdAt),
            and(eq(turns.created_at, cursor.createdAt), lt(turns.id, cursor.id)),
          )
        : undefined
      const rows = await db.select()
        .from(turns)
        .where(and(eq(turns.thread_id, threadId), cursorWhere))
        .orderBy(desc(turns.created_at), desc(turns.id))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const selectedRows = hasMore ? rows.slice(0, limit) : rows
      const selectedIds = selectedRows.map(row => row.id)
      const oldest = selectedRows.at(-1)

      if (selectedIds.length === 0) {
        return {
          turns: [],
        }
      }

      const usageByTurn = await readTurnUsage(db, selectedIds)

      return {
        turns: selectedRows.toReversed().map(row => turnFromRow(
          row,
          usageByTurn.get(row.id) ?? createTokenUsage(),
        )),
        ...(hasMore && oldest
          ? { nextCursor: { createdAt: oldest.created_at, id: oldest.id } }
          : {}),
      }
    },
    /**
     * 读取指定线程最新 Turn
     */
    readLatest: async (threadId) => {
      const [row] = await db.select()
        .from(schema.turns)
        .where(eq(schema.turns.thread_id, threadId))
        .orderBy(
          desc(schema.turns.created_at),
          desc(schema.turns.id),
        )
        .limit(1)

      if (!row)
        return

      const usageByTurn = await readTurnUsage(db, [row.id])

      return turnFromRow(row, usageByTurn.get(row.id) ?? createTokenUsage())
    },
    /**
     * 批量读取指定线程的最新 Turn，不触发 usage 聚合
     */
    latest: async (threadIds) => {
      if (threadIds.length === 0)
        return []

      const { turns } = schema
      const newerTurn = alias(turns, 'newer_turn')
      const rows = await db.select({
        threadId: turns.thread_id,
        interrupt: turns.interrupt_json,
      })
        .from(turns)
        .where(and(
          inArray(turns.thread_id, threadIds),
          notExists(
            db.select({ id: newerTurn.id })
              .from(newerTurn)
              .where(and(
                eq(newerTurn.thread_id, turns.thread_id),
                or(
                  gt(newerTurn.created_at, turns.created_at),
                  and(
                    eq(newerTurn.created_at, turns.created_at),
                    gt(newerTurn.id, turns.id),
                  ),
                ),
              )),
          ),
        ))

      return rows.map(row => ({
        threadId: row.threadId,
        interrupt: row.interrupt === null
          ? null
          : jsonParse<UnknownRecord | null>(row.interrupt, null),
      }))
    },
    /**
     * 在数据库内按线程聚合 Step 用量
     */
    listUsage: async () => {
      const { steps, turns } = schema
      const rows = await db.select({
        threadId: turns.thread_id,
        ...STEP_USAGE_SELECTION,
      })
        .from(turns)
        .leftJoin(steps, eq(steps.turn_id, turns.id))
        .groupBy(turns.thread_id)

      return rows.map(row => ({
        threadId: row.threadId,
        usage: createTokenUsage(row),
      }))
    },
  }
}
