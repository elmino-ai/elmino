import type { RuntimeLatestTurnRecord, RuntimeThreadRecord } from '@elmino/store'
import type { ThreadInterrupt } from '../runtime/interrupt.js'
import type { ThreadListItem } from './state.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 将 RuntimeStore 轻量记录投影为线程列表项
 */
export function runtimeRecordsToThreadListItem(
  thread: RuntimeThreadRecord,
  latestTurn?: RuntimeLatestTurnRecord,
): ThreadListItem {
  return {
    threadId: thread.id,
    title: thread.title,
    workspaceId: thread.metadata.workspaceId as string,
    agentId: thread.agentId,
    pinned: thread.pinned,
    unreadAt: thread.unreadAt,
    archivedAt: thread.archivedAt,
    lastInteractionAt: thread.lastInteractionAt,
    updatedAt: thread.updatedAt,
    settings: thread.settings,
    runtime: {
      status: thread.status,
      interrupt: (latestTurn?.interrupt ?? undefined) as ThreadInterrupt | undefined,
    },
  }
}
