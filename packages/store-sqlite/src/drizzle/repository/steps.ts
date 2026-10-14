import type { RuntimeStepRecord, RuntimeStepRepository } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index'
import { createId } from '@elmino/shared'
import dayjs from 'dayjs'
import { and, asc, eq } from 'drizzle-orm'
import * as schema from '../schema/index'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建 Step 结算事实仓储，不拥有连接或事务生命周期
 */
export function createStepRepository(db: RuntimeDrizzleDatabase): RuntimeStepRepository {
  /**
   * 读取单条 Step 事实
   */
  const read = async (id: string) => {
    const [row] = await db.select()
      .from(schema.steps)
      .where(eq(schema.steps.id, id))

    return row && stepFromRow(row)
  }

  return {
    /**
     * 创建带调用前输入估算的 Step 事实
     */
    create: async (input) => {
      const id = input.id ?? createId('step')
      const inputTokens = tokenCount(input.input)
      const estimatedTokens = Math.min(
        tokenCount(input.estimated),
        inputTokens,
      )

      await db.insert(schema.steps).values({
        id,
        turn_id: input.turnId,
        status: 'running',
        input: inputTokens,
        output: 0,
        reasoning: 0,
        cache_write: 0,
        cache_read: 0,
        estimated: estimatedTokens,
        created_at: input.createdAt ?? dayjs().toISOString(),
        ended_at: null,
      })

      return (await read(id))!
    },

    /**
     * 原子结算仍在运行的 Step 事实
     */
    settle: async (id, input) => {
      const inputTokens = tokenCount(input.input)
      const outputTokens = tokenCount(input.output)
      const reasoningTokens = Math.min(tokenCount(input.reasoning), outputTokens)
      const cacheWriteTokens = Math.min(tokenCount(input.cacheWrite), inputTokens)
      const cacheReadTokens = Math.min(tokenCount(input.cacheRead), inputTokens)
      const totalTokens = inputTokens + outputTokens
      const [row] = await db.update(schema.steps)
        .set({
          status: input.status,
          input: inputTokens,
          output: outputTokens,
          reasoning: reasoningTokens,
          cache_write: cacheWriteTokens,
          cache_read: cacheReadTokens,
          estimated: Math.min(tokenCount(input.estimated), totalTokens),
          ended_at: input.endedAt ?? dayjs().toISOString(),
        })
        .where(and(
          eq(schema.steps.id, id),
          eq(schema.steps.status, 'running'),
        ))
        .returning()

      return row && stepFromRow(row)
    },

    /**
     * 列出指定 Turn 的 Step 事实
     */
    list: async (turnId) => {
      const rows = await db.select()
        .from(schema.steps)
        .where(eq(schema.steps.turn_id, turnId))
        .orderBy(asc(schema.steps.created_at))

      return rows.map(stepFromRow)
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将 Step 行映射为运行事实
 */
function stepFromRow(row: typeof schema.steps.$inferSelect): RuntimeStepRecord {
  const endedAt = row.ended_at

  return {
    id: row.id,
    turnId: row.turn_id,
    status: row.status,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    estimated: row.estimated,
    createdAt: row.created_at,
    ...(endedAt ? { endedAt } : {}),
  }
}

/**
 * 归一化写入数据库的 token 数
 */
function tokenCount(value: number) {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}
