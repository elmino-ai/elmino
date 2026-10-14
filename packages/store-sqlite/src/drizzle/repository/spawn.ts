import type { RuntimeStoreTx, RuntimeThreadSpawnEdgeRecord, RuntimeTurnSpawnEdgeRecord } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index.js'
import { createTokenUsage } from '@elmino/store'
import dayjs from 'dayjs'
import { and, asc, desc, eq, gt, notExists, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { threadFromRow, turnFromRow } from '../codec/index.js'
import { readTurnUsage } from '../query/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建子线程与 Turn 派生关系仓储，不拥有连接或事务生命周期
 */
export function createSpawnRepositories(
  db: RuntimeDrizzleDatabase,
): Pick<RuntimeStoreTx, 'spawnEdges' | 'turnSpawnEdges'> {
  /**
   * 按子线程读取派生关系
   */
  const readSpawnEdge = async (childThreadId: string) => {
    const [row] = await db.select()
      .from(schema.threadSpawnEdges)
      .where(eq(schema.threadSpawnEdges.child_thread_id, childThreadId))

    return row && spawnEdgeFromRow(row)
  }

  /**
   * 列出全部或指定父线程的派生关系
   */
  const listSpawnEdges = async (parentThreadId?: string) => {
    const query = db.select().from(schema.threadSpawnEdges)
    const rows = parentThreadId
      ? await query
          .where(eq(schema.threadSpawnEdges.parent_thread_id, parentThreadId))
          .orderBy(asc(schema.threadSpawnEdges.created_at))
      : await query.orderBy(asc(schema.threadSpawnEdges.created_at))

    return rows.map(spawnEdgeFromRow)
  }

  /**
   * 按子线程 Turn 读取派生关系
   */
  const readTurnSpawnEdgeByChild = async (childTurnId: string) => {
    const [row] = await db.select()
      .from(schema.turnSpawnEdges)
      .where(eq(schema.turnSpawnEdges.child_turn_id, childTurnId))

    return row && turnSpawnEdgeFromRow(row)
  }

  return {
    spawnEdges: {
      /**
       * 创建子线程派生关系
       */
      create: async (input) => {
        await db.insert(schema.threadSpawnEdges).values({
          child_thread_id: input.childThreadId,
          parent_thread_id: input.parentThreadId,
          owner_id: input.ownerId,
          created_at: input.createdAt ?? dayjs().toISOString(),
        })

        return (await readSpawnEdge(input.childThreadId))!
      },
      readByChild: readSpawnEdge,
      listChildren: listSpawnEdges,
      /**
       * 一次查询父线程的直接子线程、派生 Turn 与父工具调用，并为每个子线程保留最新 Turn
       */
      listChildrenWithLatestTurn: async (parentThreadId) => {
        const { threadSpawnEdges, threads, turns, turnSpawnEdges } = schema
        const newerTurn = alias(turns, 'newer_child_turn')
        const newerTurnEdge = alias(turnSpawnEdges, 'newer_child_turn_edge')
        // 只比较带派生关系的 Turn，普通后续 Turn 不应遮住最近一次子智能体执行
        const rows = await db.select({
          edge: threadSpawnEdges,
          thread: threads,
          turn: turns,
          turnEdge: turnSpawnEdges,
        })
          .from(threadSpawnEdges)
          .innerJoin(threads, eq(threadSpawnEdges.child_thread_id, threads.id))
          .innerJoin(turns, eq(turns.thread_id, threads.id))
          .innerJoin(turnSpawnEdges, eq(turnSpawnEdges.child_turn_id, turns.id))
          .where(and(
            eq(threadSpawnEdges.parent_thread_id, parentThreadId),
            notExists(
              db.select({ id: newerTurn.id })
                .from(newerTurn)
                .innerJoin(newerTurnEdge, eq(newerTurnEdge.child_turn_id, newerTurn.id))
                .where(and(
                  eq(newerTurn.thread_id, turns.thread_id),
                  or(
                    gt(newerTurn.created_at, turns.created_at),
                    and(eq(newerTurn.created_at, turns.created_at), gt(newerTurn.id, turns.id)),
                  ),
                )),
            ),
          ))
          .orderBy(asc(threadSpawnEdges.created_at), desc(turns.created_at), desc(turns.id))
        const usageByTurn = await readTurnUsage(db, rows.map(row => row.turn.id))

        return rows.map((row) => {
          const turnId = row.turn.id

          return {
            ownerId: row.edge.owner_id,
            thread: threadFromRow(row.thread),
            turn: turnFromRow(row.turn, usageByTurn.get(turnId) ?? createTokenUsage()),
            parentToolCallId: row.turnEdge.parent_tool_call_id,
          }
        })
      },
      list: listSpawnEdges,
    },
    turnSpawnEdges: {
      /**
       * 创建子线程 Turn 与父工具调用的派生关系
       */
      create: async (input) => {
        await db.insert(schema.turnSpawnEdges).values({
          child_turn_id: input.childTurnId,
          parent_tool_call_id: input.parentToolCallId,
          created_at: input.createdAt ?? dayjs().toISOString(),
        })

        return (await readTurnSpawnEdgeByChild(input.childTurnId))!
      },
      readByChildTurn: readTurnSpawnEdgeByChild,
      /**
       * 按父工具调用读取派生关系
       */
      readByParentToolCall: async (parentToolCallId) => {
        const [row] = await db.select()
          .from(schema.turnSpawnEdges)
          .where(eq(schema.turnSpawnEdges.parent_tool_call_id, parentToolCallId))

        return row && turnSpawnEdgeFromRow(row)
      },

      /**
       * 列出父 Turn 派生的子线程 Turn 关系
       */
      listChildren: async (parentTurnId) => {
        // 保留 JOIN 以利用父 Turn 和父工具调用索引，关联 EXISTS 会逐条扫描派生边
        const rows = await db.select({ edge: schema.turnSpawnEdges })
          .from(schema.turnSpawnEdges)
          .innerJoin(
            schema.toolCalls,
            eq(schema.turnSpawnEdges.parent_tool_call_id, schema.toolCalls.id),
          )
          .where(eq(schema.toolCalls.turn_id, parentTurnId))
          .orderBy(asc(schema.turnSpawnEdges.created_at))

        return rows.map(row => turnSpawnEdgeFromRow(row.edge))
      },
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将子线程派生关系行映射为记录
 */
function spawnEdgeFromRow(row: typeof schema.threadSpawnEdges.$inferSelect): RuntimeThreadSpawnEdgeRecord {
  return {
    ownerId: row.owner_id,
    parentThreadId: row.parent_thread_id,
    childThreadId: row.child_thread_id,
    createdAt: row.created_at,
  }
}

/**
 * 将子线程 Turn 派生关系行映射为记录
 */
function turnSpawnEdgeFromRow(row: typeof schema.turnSpawnEdges.$inferSelect): RuntimeTurnSpawnEdgeRecord {
  return {
    childTurnId: row.child_turn_id,
    parentToolCallId: row.parent_tool_call_id,
    createdAt: row.created_at,
  }
}
