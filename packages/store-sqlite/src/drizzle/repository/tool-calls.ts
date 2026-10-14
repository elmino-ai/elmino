import type { RuntimeToolCallRecord, RuntimeToolCallRepository, UpdateRuntimeToolCallInput } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index'
import { createId } from '@elmino/shared'
import { asc, eq } from 'drizzle-orm'
import { readJsonObject } from '../codec/index'
import * as schema from '../schema/index'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建工具调用事实仓储，不拥有连接或事务生命周期
 */
export function createToolCallRepository(db: RuntimeDrizzleDatabase): RuntimeToolCallRepository {
  /**
   * 创建带完整归属的工具调用查询
   */
  const ownershipQuery = () => {
    return db.select({
      toolCall: schema.toolCalls,
      threadId: schema.turns.thread_id,
    })
      .from(schema.toolCalls)
      .innerJoin(schema.turns, eq(schema.toolCalls.turn_id, schema.turns.id))
  }

  /**
   * 读取工具调用并派生线程和消息归属
   */
  const read = async (id: string) => {
    const [row] = await ownershipQuery().where(eq(schema.toolCalls.id, id))

    return row && toolCallFromJoinedRow(row)
  }

  /**
   * 更新工具调用记录
   */
  const update = async (id: string, input: UpdateRuntimeToolCallInput) => {
    const current = (await read(id))!
    const next = {
      ...current,
      startedAt: 'startedAt' in input
        ? input.startedAt ?? null
        : current.startedAt,
      status: input.status ?? current.status,
      decision: 'decision' in input
        ? input.decision ?? null
        : current.decision,
      completedAt: 'completedAt' in input
        ? input.completedAt ?? null
        : current.completedAt,
      errorMessage: 'errorMessage' in input
        ? input.errorMessage ?? null
        : current.errorMessage,
      resultPartId: 'resultPartId' in input
        ? input.resultPartId ?? null
        : current.resultPartId,
    }

    await db.update(schema.toolCalls)
      .set({
        status: next.status,
        decision: next.decision,
        started_at: next.startedAt,
        completed_at: next.completedAt,
        error_message: next.errorMessage,
        result_part_id: next.resultPartId,
      })
      .where(eq(schema.toolCalls.id, id))

    return (await read(id))!
  }

  return {
    /**
     * 创建工具调用记录
     */
    create: async (input) => {
      const id = input.id ?? createId('tool')

      await db.insert(schema.toolCalls).values({
        id,
        turn_id: input.turnId,
        assistant_message_id: input.assistantMessageId,
        assistant_part_id: input.assistantPartId,
        provider_call_id: input.providerCallId,
        name: input.name,
        args_json: JSON.stringify(input.args),
        status: input.status ?? 'pending',
        decision: input.decision ?? null,
        started_at: input.startedAt ?? null,
        completed_at: null,
        error_message: null,
        result_part_id: null,
      })

      return (await read(id))!
    },
    update,
    /**
     * 列出工具调用记录
     */
    list: async (input) => {
      const query = ownershipQuery()
      const rows = input.turnId
        ? await query
            .where(eq(schema.toolCalls.turn_id, input.turnId))
            .orderBy(asc(schema.toolCalls.started_at), asc(schema.toolCalls.id))
        : input.threadId
          ? await query
              .where(eq(schema.turns.thread_id, input.threadId))
              .orderBy(asc(schema.turns.started_at), asc(schema.toolCalls.id))
          : []

      return rows.map(toolCallFromJoinedRow)
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将工具调用联表结果映射为记录
 */
function toolCallFromJoinedRow(row: {
  toolCall: typeof schema.toolCalls.$inferSelect
  threadId: string
}): RuntimeToolCallRecord {
  const toolCall = row.toolCall

  return {
    id: toolCall.id,
    threadId: row.threadId,
    turnId: toolCall.turn_id,
    assistantMessageId: toolCall.assistant_message_id,
    assistantPartId: toolCall.assistant_part_id,
    providerCallId: toolCall.provider_call_id,
    name: toolCall.name,
    args: readJsonObject(toolCall.args_json),
    status: toolCall.status,
    decision: toolCall.decision,
    startedAt: toolCall.started_at,
    completedAt: toolCall.completed_at,
    errorMessage: toolCall.error_message,
    resultPartId: toolCall.result_part_id,
  }
}
