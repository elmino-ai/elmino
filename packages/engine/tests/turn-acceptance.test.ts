import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import {
  createAgent,
  createEngine,
  createEngineStore,
  disposeEngineStore,
  testId,
  turnRequest,
} from './support/engine.js'

/** -------------------- 测试 -------------------- */
test('Engine 仅在输入与启动状态持久化后确认接纳，后续失败不撤销确认', async () => {
  const { root, store } = await createEngineStore()
  const input = Promise.withResolvers<[{ type: 'text', text: string }]>()
  const gate = Promise.withResolvers<void>()
  const failure = new Error('Provider 执行失败')
  const engine = createEngine(createAgent(async () => {
    await gate.promise
    throw failure
  }))
  const threadId = 'thread-acceptance'
  const turnId = testId('turn', 'acceptance')

  try {
    const execution = engine.run({ ...turnRequest(threadId, turnId), input: () => input.promise }, store)
    const accepted = vi.fn()

    execution.accepted.then(accepted, () => undefined)
    await setImmediate()
    expect(accepted).not.toHaveBeenCalled()
    input.resolve([{ type: 'text', text: '先接纳，后执行' }])
    await execution.accepted
    expect(await store.turns.read(turnId)).toMatchObject({ status: 'running' })
    expect(await store.canonical.list(threadId)).toHaveLength(1)
    const completed = vi.fn()

    execution.completed.then(completed, () => undefined)
    await setImmediate()
    expect(completed).not.toHaveBeenCalled()
    gate.resolve()
    await expect(execution.completed).rejects.toBe(failure)
    await expect(execution.accepted).resolves.toBeUndefined()
    expect(await store.turns.read(turnId)).toMatchObject({ status: 'failed' })
  }
  finally {
    input.resolve([{ type: 'text', text: '测试清理' }])
    gate.resolve()
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('Engine 接纳前失败同时拒绝接纳确认与执行结果', async () => {
  const { root, store } = await createEngineStore()
  const failure = new Error('输入准备失败')
  const engine = createEngine(createAgent(() => Promise.reject(new Error('不应开始执行'))))

  try {
    const execution = engine.run({
      ...turnRequest('thread-rejected', testId('turn', 'rejected')),
      input: () => Promise.reject(failure),
    }, store)

    await expect(execution.accepted).rejects.toBe(failure)
    await expect(execution.completed).rejects.toBe(failure)
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})
