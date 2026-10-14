import type { RuntimeStore, ThreadTokenUsage } from '@elmino/store'
import type { ThreadUsagePayload } from '../runtime/budget'
import { createTokenUsage, mergeTokenUsage } from '@elmino/store'

/** -------------------- 类型 -------------------- */
/** 线程用量事件投影 */
export interface ThreadUsageProjection extends ThreadUsagePayload {
  /** 投影所属线程 ID */
  threadId: string
}

/** -------------------- 核心函数 -------------------- */
/**
 * 读取当前线程自身及所有派生子线程的累计用量
 */
export async function readThreadUsage(store: RuntimeStore, threadId: string) {
  const projections = await readAffectedThreadUsages(store, threadId)

  return projections[0] ?? {
    threadId,
    usage: createTokenUsage(),
    taskUsage: createTokenUsage(),
  }
}

/**
 * 读取当前线程及全部祖先线程受影响的用量投影
 */
export async function readAffectedThreadUsages(
  store: RuntimeStore,
  threadId: string,
) {
  const [threadUsages, edges] = await Promise.all([
    store.turns.listUsage(),
    store.spawnEdges.list(),
  ])
  const usageByThread = new Map<string, ThreadTokenUsage>()
  const childrenByParent = new Map<string, string[]>()
  const parentByChild = new Map<string, string>()

  for (const record of threadUsages)
    usageByThread.set(record.threadId, record.usage)

  for (const edge of edges) {
    childrenByParent.set(edge.parentThreadId, [
      ...(childrenByParent.get(edge.parentThreadId) ?? []),
      edge.childThreadId,
    ])
    parentByChild.set(edge.childThreadId, edge.parentThreadId)
  }

  /** 递归汇总指定线程及其后代，异常环路只统计一次 */
  const project = (currentThreadId: string): ThreadUsageProjection => {
    const usage = usageByThread.get(currentThreadId) ?? createTokenUsage()
    let taskUsage = createTokenUsage()
    const pending = [currentThreadId]
    const visited = new Set<string>()

    while (pending.length > 0) {
      const id = pending.pop()!

      if (visited.has(id))
        continue

      visited.add(id)
      taskUsage = mergeTokenUsage(taskUsage, usageByThread.get(id) ?? {})
      pending.push(...childrenByParent.get(id) ?? [])
    }

    return {
      threadId: currentThreadId,
      usage,
      taskUsage,
    }
  }
  const projections: ThreadUsageProjection[] = []
  const visitedAncestors = new Set<string>()
  let currentThreadId: string | undefined = threadId

  while (currentThreadId && !visitedAncestors.has(currentThreadId)) {
    visitedAncestors.add(currentThreadId)
    projections.push(project(currentThreadId))
    currentThreadId = parentByChild.get(currentThreadId)
  }

  return projections
}
