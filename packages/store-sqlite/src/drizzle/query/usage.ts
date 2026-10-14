import type { ThreadTokenUsage } from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../types/index'
import { createTokenUsage } from '@elmino/store'
import { inArray, sql } from 'drizzle-orm'
import * as schema from '../schema/index'

/** -------------------- 常量 -------------------- */
/** 按 Step 限制子项上限后汇总，供 Turn 和线程共享同一用量口径 */
export const STEP_USAGE_SELECTION = {
  input: sql`coalesce(sum(${schema.steps.input}), 0)`.mapWith(Number),
  output: sql`coalesce(sum(${schema.steps.output}), 0)`.mapWith(Number),
  reasoning: sql`coalesce(sum(min(${schema.steps.reasoning}, ${schema.steps.output})), 0)`.mapWith(Number),
  cacheWrite: sql`coalesce(sum(min(${schema.steps.cache_write}, ${schema.steps.input})), 0)`.mapWith(Number),
  cacheRead: sql`coalesce(sum(min(${schema.steps.cache_read}, ${schema.steps.input})), 0)`.mapWith(Number),
  estimated: sql`coalesce(sum(min(${schema.steps.estimated}, ${schema.steps.input} + ${schema.steps.output})), 0)`
    .mapWith(Number),
}

/** -------------------- 核心函数 -------------------- */
/**
 * 按 Turn 聚合 Step 事实
 */
export async function readTurnUsage(db: RuntimeDrizzleDatabase, turnIds: string[]) {
  const usageByTurn = new Map<string, ThreadTokenUsage>()

  if (turnIds.length === 0)
    return usageByTurn

  const { steps } = schema
  const rows = await db.select({
    turnId: steps.turn_id,
    ...STEP_USAGE_SELECTION,
  })
    .from(steps)
    .where(inArray(steps.turn_id, turnIds))
    .groupBy(steps.turn_id)

  for (const row of rows)
    usageByTurn.set(row.turnId, createTokenUsage(row))

  return usageByTurn
}
