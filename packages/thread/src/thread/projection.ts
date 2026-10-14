import type { UnknownRecord } from '@elmino/shared'
import type { ThreadRuntimeState } from '../runtime/state'
import type { Thread, ThreadExtensionState } from './types'
import { objectOmit, objectPick } from '@elmino/shared'
import { createThreadSnapshotRecord } from './snapshot'

/** -------------------- 核心函数 -------------------- */
/**
 * 定义线程快照到宿主线程数据状态的投影能力
 */
export function defineThread(options: {
  /** 从命名空间恢复状态读取公开扩展状态 */
  state?: (state: ThreadExtensionState) => Record<string, UnknownRecord>
} = {}): Thread {
  return {
    toState: (record, input = {}) => {
      const threadSnapshot = createThreadSnapshotRecord(record)
      const extensions = options.state?.(threadSnapshot.extensionState) ?? {}
      const taskUsage = input.taskUsage ?? threadSnapshot.usage
      const latestTurn = threadSnapshot.turnId
        ? input.turns?.find(turn => turn.id === threadSnapshot.turnId)
        : undefined
      const currentTurnId = threadSnapshot.turnId && (
        threadSnapshot.status === 'running'
        || threadSnapshot.status === 'interrupted'
        || latestTurn?.status === 'queued'
        || latestTurn?.status === 'running'
        || latestTurn?.status === 'interrupted'
      )
        ? threadSnapshot.turnId
        : undefined
      // extensionState 是内部恢复事实，只有经过宿主状态定义读取的扩展状态才能进入公开数据
      const runtime: ThreadRuntimeState = {
        ...objectPick(
          threadSnapshot,
          'status',
          'modelId',
          'agentId',
          'approvalMode',
          'usage',
          'contextBudget',
          'interrupt',
        ),
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        taskUsage,
      }

      return {
        ...objectOmit(
          threadSnapshot,
          'autoTitle',
          'userTitle',
          'unreadAt',
          'approvalMode',
          'contextProjection',
          'contextBudget',
          'interrupt',
          'modelId',
          'location',
          'extensionState',
          'turnId',
          'status',
          'usage',
        ),
        workspaceId: threadSnapshot.location.workspaceId,
        workspaceRoot: threadSnapshot.location.workspaceRoot,
        cwd: threadSnapshot.location.cwd,
        ...((threadSnapshot.userTitle || threadSnapshot.autoTitle)
          ? { title: threadSnapshot.userTitle || threadSnapshot.autoTitle! }
          : {}),
        unreadAt: threadSnapshot.unreadAt,
        extensions,
        messages: input.messages ?? [],
        turns: input.turns ?? [],
        children: input.children ?? [],
        runtime,
      }
    },
  }
}
