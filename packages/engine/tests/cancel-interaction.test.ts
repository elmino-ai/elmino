import type { RuntimeEvent } from '@elmino/thread/events'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { expect, onTestFinished, test, vi } from 'vitest'
import { TurnControlRegistry } from '../src/engine/control'
import { AgentEngine } from '../src/engine/engine'
import {
  completedTurnResult,
  createAgent,
  createEngineStore,
  disposeEngineStore,
  interruptedTurnResult,
  resumableTurnRequest,
  seedParentTurn,
  testId,
  testSubagentRole,
} from './support/engine'

/** 外部通知失败不能切断真实子任务取消后的内部等待唤醒与父线程投影 */
test('取消待交互 Child 时宿主事件回调失败，仍唤醒父等待并发布取消状态', async () => {
  const { root, store } = await createEngineStore()
  const parentThreadId = 'thread-parent-cancel-interaction'
  const parentTurnId = testId('turn', 'parent-cancel-interaction')
  const parentRelease = Promise.withResolvers<void>()
  const spawned = Promise.withResolvers<{ threadId: string, turnId: string }>()
  const waitController = new AbortController()
  const notifications = vi.spyOn(TurnControlRegistry.prototype, 'notifySubagent')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const failure = new Error('宿主拒绝取消事件通知')
  const events: RuntimeEvent[] = []
  let parentObserved: string | undefined
  const agent = createAgent(async (context) => {
    if (context.parentThreadId)
      return interruptedTurnResult(context.turnId)
    const child = await context.testSubagents!.spawn({
      role: testSubagentRole.id,
      name: '等待人工确认的 Child',
      description: '取消后必须唤醒原父任务等待',
      ownerId: 'subagent',
      parentToolCallId: 'tool-child-cancel-interaction',
    })
    spawned.resolve(child)
    await parentRelease.promise
    const result = await context.testSubagents!.wait({ threadIds: [child.threadId], timeoutMs: 1_000 })
    parentObserved = result.subagents[0]?.status
    return completedTurnResult()
  })
  const engine = AgentEngine.create({ [agent.id]: agent }, {
    onRuntimeEvent: (_agentId, event) => {
      events.push(event)
      if (event.type === 'turn.cancelled')
        throw failure
    },
  })
  onTestFinished(async () => {
    parentRelease.resolve()
    waitController.abort()
    try {
      await engine.close()
    }
    finally {
      notifications.mockRestore()
      warn.mockRestore()
      await disposeEngineStore(root, store)
    }
  })
  await seedParentTurn(store, parentThreadId, parentTurnId, ['tool-child-cancel-interaction'])
  const parent = engine.resume(resumableTurnRequest(parentThreadId, parentTurnId), store)
  const child = await spawned.promise
  await vi.waitFor(async () => {
    expect((await store.turns.read(child.turnId))?.status).toBe('interrupted')
    expect(notifications).toHaveBeenCalledWith(child.threadId)
  })
  // 使用真实 Engine 注册表，直接等待与父 wait_subagents 相同的状态变化通知
  const controls = notifications.mock.contexts.find(context => context instanceof TurnControlRegistry)!
  await controls.waitForCompletion(child.threadId, child.turnId)
  const waiting = controls.waitForSubagentChange([child.threadId], 5_000, waitController.signal)
  notifications.mockClear()
  const interrupted = (await store.turns.read(child.turnId))!
  const interrupt = readThreadInteraction(readThreadInterrupt(interrupted.interrupt))!
  const result = await engine.cancelInteraction({
    agentId: agent.id,
    ...child,
    interruptId: interrupt.id,
    store,
    reason: '用户取消子任务',
  })
  expect(result).toBe(true)
  await expect(waiting).resolves.toBe(false)
  expect(notifications).toHaveBeenCalledWith(child.threadId)
  expect(await store.turns.read(child.turnId)).toMatchObject({ status: 'cancelled', interrupt: null })
  expect(events).toContainEqual(expect.objectContaining({
    type: 'thread.child.updated',
    threadId: parentThreadId,
    payload: expect.objectContaining({ threadId: child.threadId, turnId: child.turnId, status: 'cancelled' }),
  }))
  expect(warn).toHaveBeenCalledWith('[engine] Turn 取消事件发布失败', failure)
  parentRelease.resolve()
  await parent.completed
  expect(parentObserved).toBe('cancelled')
}, 10_000)
