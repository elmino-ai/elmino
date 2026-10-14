import type { RuntimeTurnRecord, SubagentRole, ThreadTokenUsage } from '@elmino/store'
import type * as schema from '../schema/index'
import { readJson, readJsonObject } from './json'

/** -------------------- 核心函数 -------------------- */
/**
 * 将 turn 行映射为记录
 */
export function turnFromRow(
  row: typeof schema.turns.$inferSelect,
  usage: ThreadTokenUsage,
): RuntimeTurnRecord {
  const startedAt = row.started_at
  const endedAt = row.ended_at

  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    modelConfig: readJsonObject(row.model_config_json),
    subagentRole: readJsonObject(row.subagent_role_json) as unknown as SubagentRole,
    subagentRoles: readJson(row.subagent_roles_json) as SubagentRole[],
    agentSnapshot: readJsonObject(row.agent_snapshot_json),
    approvalMode: row.approval_mode,
    subagentMode: row.subagent_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    errorMessage: row.error_message,
    usage,
    interrupt: readJsonObject(row.interrupt_json, { nullable: true }),
  }
}
