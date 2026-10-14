import type { ThreadLocation } from '@elmino/runtime'
import type { UnknownRecord } from '@elmino/shared'
import type {
  RuntimeStore,
  RuntimeStoreTx,
  RuntimeThreadRecord,
  RuntimeTurnRecord,
  ThreadStatus,
  ThreadTokenUsage,
} from '@elmino/store'
import type { ThreadInterrupt } from '../runtime/interrupt.js'
import type { CreateThreadSnapshotRecordInput, ThreadSnapshotRecord, ThreadSnapshotUpdate } from './types.js'
import { objectEntries, objectPick } from '@elmino/shared'
import { createTokenUsage, mergeTokenUsage } from '@elmino/store'
import dayjs from 'dayjs'
import { createThreadSnapshotRecord } from './snapshot.js'

/** -------------------- 类型 -------------------- */
/** threads.state_json 唯一允许保存的可恢复上下文 */
type PersistedThreadSnapshotState = Pick<
  ThreadSnapshotRecord,
  | 'contextProjection'
  | 'contextBudget'
  | 'extensionState'
>

/** -------------------- 核心函数 -------------------- */
/**
 * 从 RuntimeStore 读取线程恢复快照
 */
export async function readThreadSnapshot(
  store: RuntimeStoreTx,
  threadId: string,
  location: ThreadLocation,
) {
  const thread = await store.threads.read(threadId)

  if (!thread)
    return

  return runtimeRecordsToThreadSnapshot(
    thread,
    await store.turns.list(threadId),
    location,
  )
}

/**
 * 写入完整线程恢复快照
 */
export async function writeThreadSnapshot(
  store: RuntimeStoreTx,
  record: CreateThreadSnapshotRecordInput,
) {
  await persistThreadSnapshot(store, record)
}

/**
 * 局部更新线程恢复快照
 */
export async function updateThreadSnapshot(
  store: RuntimeStore,
  threadId: string,
  update: ThreadSnapshotUpdate,
) {
  await store.transaction(tx => updateThreadSnapshotTx(tx, threadId, update))
}

/**
 * 更新单个扩展命名空间并保留事务开始时的其他插件状态
 */
export async function updateThreadExtensionState(
  store: RuntimeStore,
  threadId: string,
  extensionId: string,
  state?: UnknownRecord,
) {
  await store.transaction(tx => updateThreadExtensionStateTx(
    tx,
    threadId,
    extensionId,
    state,
  ))
}

/**
 * 在调用方已有事务中更新单个扩展命名空间
 */
export async function updateThreadExtensionStateTx(
  store: RuntimeStoreTx,
  threadId: string,
  extensionId: string,
  state?: UnknownRecord,
) {
  await updateThreadSnapshotTx(
    store,
    threadId,
    state === undefined ? {} : { extensionStatePatch: { [extensionId]: state } },
    state === undefined ? extensionId : undefined,
  )
}

/**
 * 删除线程恢复快照
 */
export async function removeThreadSnapshot(store: RuntimeStoreTx, threadId: string) {
  await store.threads.remove(threadId)
}

/**
 * 从已读取的 RuntimeStore Thread 和 Turn 事实恢复线程快照
 */
export function runtimeRecordsToThreadSnapshot(
  thread: RuntimeThreadRecord,
  turns: RuntimeTurnRecord[],
  location: ThreadLocation,
) {
  const latestTurn = turns.reduce<RuntimeTurnRecord | undefined>((latest, turn) => {
    if (!latest)
      return turn

    return turn.createdAt.localeCompare(latest.createdAt) > 0
      || (turn.createdAt === latest.createdAt && turn.id.localeCompare(latest.id) > 0)
      ? turn
      : latest
  }, undefined)
  const usage = turns.reduce(
    (total, turn) => mergeTokenUsage(total, turn.usage),
    createTokenUsage(),
  )

  return runtimeSummaryToThreadSnapshot(thread, latestTurn, usage, location)
}

/**
 * 从有界的 RuntimeStore 最新 Turn 和累计用量恢复线程快照
 */
export function runtimeSummaryToThreadSnapshot(
  thread: RuntimeThreadRecord,
  latestTurn: RuntimeTurnRecord | undefined,
  usage: ThreadTokenUsage,
  location: ThreadLocation,
) {
  return mergeThreadTurnFacts(
    restoreThreadSnapshot(thread, thread.state, location),
    latestTurn,
    usage,
  )
}

/** -------------------- 内部函数 -------------------- */
/**
 * 在同一事务读取并合并线程恢复上下文
 */
export async function updateThreadSnapshotTx(
  store: RuntimeStoreTx,
  threadId: string,
  update: ThreadSnapshotUpdate,
  removeExtensionId?: string,
) {
  const thread = await store.threads.read(threadId)

  if (!thread)
    throw new Error(`线程不存在: ${threadId}`)

  const {
    lastInteractionAt: _lastInteractionAt,
    extensionStatePatch,
    ...contextUpdate
  } = update
  const updatedAt = nextSnapshotUpdatedAt(thread.updatedAt)
  // 只在 state_json 内合并可恢复上下文，避免读取 Turn 事实后又把生命周期字段写回 Thread
  const state: UnknownRecord = {
    ...thread.state,
  }

  for (const [key, value] of objectEntries(contextUpdate)) {
    if (value === undefined)
      delete state[key]
    else
      state[key] = value
  }

  if (extensionStatePatch || removeExtensionId) {
    const extensionState = {
      ...state.extensionState as UnknownRecord | undefined,
      ...extensionStatePatch,
    }

    if (removeExtensionId)
      delete extensionState[removeExtensionId]

    state.extensionState = extensionState
  }

  const lastInteractionAt = _lastInteractionAt ?? thread.lastInteractionAt

  await store.threads.upsert({
    id: threadId,
    updatedAt,
    lastInteractionAt,
    state,
  })
}

/**
 * 提取不能从线程索引和 Turn 事实还原的当前上下文
 */
function threadSnapshotState(
  record: ThreadSnapshotRecord,
): PersistedThreadSnapshotState {
  return objectPick(
    record,
    'contextProjection',
    'contextBudget',
    'extensionState',
  )
}

/**
 * 生成同一线程内单调递增的快照更新时间
 */
function nextSnapshotUpdatedAt(current?: string) {
  const now = dayjs()

  // 快速连续写入可能落在同一毫秒，强制递增避免最新快照排序读回旧状态
  if (current && !now.isAfter(dayjs(current)))
    return dayjs(current).add(1, 'millisecond').toISOString()

  return now.toISOString()
}

/**
 * 将线程快照拆成索引字段和当前恢复状态写入同一行
 */
async function persistThreadSnapshot(
  store: RuntimeStoreTx,
  record: CreateThreadSnapshotRecordInput,
) {
  const normalizedRecord = createThreadSnapshotRecord(record)

  await store.threads.upsert({
    id: normalizedRecord.threadId,
    agentId: normalizedRecord.agentId,
    dir: normalizedRecord.location.dir,
    ...objectPick(
      normalizedRecord,
      'autoTitle',
      'userTitle',
      'status',
      'pinned',
      'unreadAt',
      'archivedAt',
      'createdAt',
      'updatedAt',
      'lastInteractionAt',
      'settings',
    ),
    metadata: {
      workspaceId: normalizedRecord.location.workspaceId,
    },
    state: threadSnapshotState(normalizedRecord),
  })
}

/**
 * 从 RuntimeStore Thread 的上下文和结构化元信息恢复完整快照
 */
function restoreThreadSnapshot(
  thread: RuntimeThreadRecord,
  state: UnknownRecord,
  location: ThreadLocation,
) {
  // 结构化列负责列表和稳定元信息，state 只负责恢复 Provider 上下文
  return createThreadSnapshotRecord({
    ...state as Partial<PersistedThreadSnapshotState>,
    threadId: thread.id,
    ...objectPick(
      thread,
      'status',
      'agentId',
      'autoTitle',
      'userTitle',
      'pinned',
      'unreadAt',
      'archivedAt',
      'createdAt',
      'updatedAt',
      'lastInteractionAt',
      'settings',
    ),
    location: {
      workspaceId: location.workspaceId,
      workspaceKind: location.workspaceKind,
      workspaceRoot: location.workspaceRoot,
      dir: thread.dir,
      cwd: location.cwd,
    },
  })
}

/**
 * 用 Turn 表权威事实补齐线程当前运行态和累计用量
 */
function mergeThreadTurnFacts(
  record: ThreadSnapshotRecord,
  latestTurn: RuntimeTurnRecord | undefined,
  usage: ThreadTokenUsage,
) {
  if (!latestTurn) {
    return createThreadSnapshotRecord({
      ...record,
      approvalMode: record.settings?.approvalMode,
    })
  }

  const modelId = latestTurn.modelConfig.id

  return createThreadSnapshotRecord({
    ...record,
    turnId: latestTurn.id,
    modelId: modelId as string,
    agentId: record.agentId,
    approvalMode: latestTurn.approvalMode,
    status: threadStatusFromTurn(latestTurn, record.status ?? 'idle'),
    usage,
    interrupt: (latestTurn.interrupt as ThreadInterrupt | null) ?? undefined,
  })
}

/**
 * 将结构化 Turn 状态映射为线程展示状态
 */
function threadStatusFromTurn(
  turn: RuntimeTurnRecord,
  fallback: ThreadStatus,
): ThreadStatus {
  // queued/cancelled 的线程展示由提交或取消场景决定，读取对应 Thread 稳定状态
  if (turn.status === 'queued' || turn.status === 'cancelled')
    return fallback

  return turn.status
}
