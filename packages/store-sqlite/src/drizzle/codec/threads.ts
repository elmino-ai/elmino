import type { RuntimeThreadRecord, ThreadSettings } from '@elmino/store'
import type * as schema from '../schema/index'
import { readJsonObject } from './json'

/** -------------------- 核心函数 -------------------- */
/**
 * 将线程行映射为记录
 */
export function threadFromRow(row: typeof schema.threads.$inferSelect): RuntimeThreadRecord {
  const autoTitle = row.auto_title
  const userTitle = row.user_title
  const title = userTitle || autoTitle

  return {
    id: row.id,
    dir: row.dir,
    lifecycle: row.lifecycle,
    agentId: row.agent_id,
    ...(title ? { title } : {}),
    autoTitle,
    userTitle,
    status: row.status,
    pinned: row.pinned,
    unreadAt: row.unread_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInteractionAt: row.last_interaction_at,
    metadata: readJsonObject(row.metadata_json),
    settings: readJsonObject(row.settings_json) as unknown as ThreadSettings,
    state: readJsonObject(row.state_json),
  }
}
