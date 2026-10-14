import type { CreateThreadSnapshotRecordInput, NormalizedThreadSnapshotRecord } from './types'
import { deepMerge } from '@elmino/shared'
import { createTokenUsage, DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import dayjs from 'dayjs'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建补齐默认运行态的线程快照记录
 */
export function createThreadSnapshotRecord(
  input: CreateThreadSnapshotRecordInput,
): NormalizedThreadSnapshotRecord {
  // 同一个 now 同时兜底 createdAt/updatedAt/lastInteractionAt，保持快照时间自洽
  const now = input.updatedAt
    ?? input.lastInteractionAt
    ?? input.createdAt
    ?? dayjs().toISOString()
  const contextProjection = input.contextProjection ?? {}
  const extensionState = input.extensionState ?? {}
  const record = deepMerge({
    threadId: input.threadId,
    agentId: input.agentId,
    autoTitle: null,
    userTitle: null,
    location: input.location,
    pinned: false,
    unreadAt: null,
    contextProjection,
    extensionState,
    settings: { ...DEFAULT_THREAD_SETTINGS },
    status: 'idle',
    approvalMode: input.settings?.approvalMode ?? DEFAULT_THREAD_SETTINGS.approvalMode,
    usage: createTokenUsage(),
    createdAt: now,
    lastInteractionAt: now,
    archivedAt: null,
    updatedAt: now,
  } satisfies NormalizedThreadSnapshotRecord, input)
  const usage = createTokenUsage(record.usage)

  return { ...record, contextProjection, extensionState, usage }
}
