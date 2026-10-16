import type { RuntimeCreateContext } from '@elmino/runtime'
import type { RuntimeStore, RuntimeStoreProvider } from '@elmino/store'
import type { Elmino } from '../src/index'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { createId } from '@elmino/shared'
import { sqliteStore } from '@elmino/store-sqlite'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createEngineStore, createTestRuntime, disposeEngineStore } from '../../engine/tests/support/engine'
import { createGatedModel } from '../../engine/tests/support/gated-model'
import { createModel, response } from '../../engine/tests/support/model'
import { defineElmino, ElminoError } from '../src/index'

const writer = defineAgent({
  id: 'writer',
  systemPrompt: '完成当前任务',
  runtime: { create: ({ location }) => createTestRuntime(location) },
})

test('同一作用域并发访问只借用一次，关闭先结算执行和事件流，再完成存储释放', async () => {
  const { root, store } = await createEngineStore()
  const gate = createGatedModel()
  const releaseEntered = Promise.withResolvers<void>()
  const releaseGate = Promise.withResolvers<void>()
  let runtimeDisposed = false
  let statusAtRelease: string | undefined
  let disposedAtRelease = false
  const turnId = createId('turn')
  const release = vi.fn(async () => {
    statusAtRelease = (await store.turns.read(turnId))?.status
    disposedAtRelease = runtimeDisposed
    releaseEntered.resolve()
    await releaseGate.promise
    await store.close()
  })
  const provider = vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store, release })
  const agent = defineAgent({
    id: 'writer',
    systemPrompt: '完成当前任务',
    runtime: { create: ({ location }: RuntimeCreateContext) => {
      const runtime = createTestRuntime(location)
      return {
        location,
        sandbox: () => runtime.sandbox(),
        dispose: async () => {
          await runtime.dispose()
          runtimeDisposed = true
        },
      }
    } },
  })
  const elmino = defineElmino({
    agents: { writer: agent },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: () => gate.model,
  })
  onTestFinished(async () => {
    releaseGate.resolve()
    gate.release()
    await elmino.close()
    await disposeEngineStore(root, store)
  })
  const scope = { agentId: 'writer', workspaceId: 'fixed' }
  await Promise.all(Array.from({ length: 3 }, () => elmino.listThreads(scope)))
  const events: string[] = []
  const drained = Promise.withResolvers<void>()
  elmino.subscribe({
    onEvent: (_, event) => { events.push(event.type) },
    onClose: () => drained.resolve(),
  })
  await elmino.createTurn({
    ...scope,
    threadId: createId('thread'),
    turnId,
    input: [{ type: 'text', text: '保持运行直到服务关闭' }],
  })
  await gate.entered
  let closed = false
  const closing = elmino.close().then(() => {
    closed = true
  })
  await releaseEntered.promise
  await drained.promise
  expect(provider).toHaveBeenCalledOnce()
  expect(disposedAtRelease).toBe(true)
  expect(statusAtRelease).toBe('interrupted')
  expect(events).toContain('turn.interrupted')
  expect(closed).toBe(false)
  releaseGate.resolve()
  await closing
  expect(release).toHaveBeenCalledOnce()
  await expect(store.turns.read(turnId)).rejects.toThrow()
})

test('同一 SQLite 配置在多 Agent 和应用实例间共享，最后释放后重启恢复历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-core-storage-'))
  const applications: Elmino[] = []
  onTestFinished(async () => {
    await Promise.all(applications.map(elmino => elmino.close()))
    await rm(root, { recursive: true, force: true })
  })
  const configuration = sqliteStore({ dataDir: path.join(root, 'data') })
  const borrowed: RuntimeStore[] = []
  const provider = vi.fn<RuntimeStoreProvider>(async (signal) => {
    const lease = await configuration(signal)
    borrowed.push(lease.store)
    return lease
  })
  const reviewer = defineAgent({
    id: 'reviewer',
    systemPrompt: '完成当前任务',
    runtime: { create: ({ location }) => createTestRuntime(location) },
  })
  const model = vi.fn(() => createModel([response([{ type: 'text', text: '存储共享完成' }])]).model)
  const options = {
    agents: { writer, reviewer },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: model,
  }
  const first = defineElmino(options)
  const second = defineElmino(options)
  applications.push(first, second)
  const targets = ['writer', 'reviewer'].map(agentId => ({
    agentId,
    workspaceId: 'fixed',
    threadId: createId('thread'),
    turnId: createId('turn'),
  }))
  await Promise.all(targets.map(target => first.createTurn({
    ...target,
    input: [{ type: 'text', text: '执行任务' }],
  })))
  await vi.waitFor(async () => {
    expect(await Promise.all(targets.map(target => borrowed[0]!.turns.read(target.turnId))))
      .toEqual(targets.map(target => expect.objectContaining({ id: target.turnId, status: 'completed' })))
  })
  const states = await Promise.all(targets.map(({ turnId: _turnId, ...target }) => second.getThread(target)))
  expect(provider).toHaveBeenCalledTimes(4)
  expect(new Set(borrowed).size).toBe(1)
  await first.close()
  for (const [index, { turnId: _turnId, ...target }] of targets.entries())
    expect(await second.getThread(target)).toEqual(states[index])
  expect(provider).toHaveBeenCalledTimes(4)
  await second.close()
  await expect(borrowed[0]!.threads.listAll()).rejects.toThrow()

  const restarted = defineElmino(options)
  applications.push(restarted)
  const restored = await Promise.all(targets.map(({ turnId: _turnId, ...target }) => restarted.getThread(target)))
  expect(restored).toEqual(states)
  expect(model).toHaveBeenCalledTimes(2)
  expect(provider).toHaveBeenCalledTimes(6)
  expect(borrowed[4]).not.toBe(borrowed[0])
  expect(borrowed[5]).toBe(borrowed[4])
})

test.each([false, true])('关闭等待异步打开，迟到借用的释放失败=%s 可观测且不覆盖关闭错误', async (releaseFails) => {
  const { root, store } = await createEngineStore()
  const entered = Promise.withResolvers<void>()
  const openGate = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const releaseFailure = new Error('测试迟到借用释放失败')
  const release = vi.fn(async () => {
    await store.close()
    if (releaseFails)
      throw releaseFailure
  })
  const provider = vi.fn<RuntimeStoreProvider>(async (input) => {
    signal = input
    entered.resolve()
    await openGate.promise
    return { store, release }
  })
  const model = vi.fn(() => {
    throw new Error('关闭期间不应解析模型')
  })
  const errors: unknown[] = []
  const elmino = defineElmino({
    agents: { writer },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: model,
    onError: (error) => {
      errors.push(error)
    },
  })
  onTestFinished(async () => {
    openGate.resolve()
    await elmino.close()
    await disposeEngineStore(root, store)
  })
  const pending = elmino.listThreads({ agentId: 'writer', workspaceId: 'fixed' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  await entered.promise
  let closed = false
  const closing = elmino.close().then(() => {
    closed = true
  })
  await vi.waitFor(() => {
    expect(signal?.aborted).toBe(true)
  })
  expect(closed).toBe(false)
  expect(release).not.toHaveBeenCalled()
  openGate.resolve()
  await rejected
  await closing
  expect(provider).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(model).not.toHaveBeenCalled()
  const causes = errors.flatMap(error => error instanceof AggregateError ? error.errors : [error])
  if (releaseFails)
    expect(causes).toContain(releaseFailure)
  else
    expect(errors).toEqual([])
  await expect(store.threads.listAll()).rejects.toThrow()
})

test('配置打开失败不会缓存失败作用域，后续请求可重新借用并最终释放', async () => {
  const { root, store } = await createEngineStore()
  const release = vi.fn(async () => {})
  const failure = new ElminoError('BAD_REQUEST', '测试配置暂不可打开')
  const provider = vi.fn<RuntimeStoreProvider>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ store, release })
  const elmino = defineElmino({
    agents: { writer },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: () => { throw new Error('列表不应解析模型') },
  })
  onTestFinished(async () => {
    await elmino.close()
    await disposeEngineStore(root, store)
  })
  const target = { agentId: 'writer', workspaceId: 'fixed' }
  await expect(elmino.listThreads(target)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: failure.message })
  expect(release).not.toHaveBeenCalled()
  expect(await elmino.listThreads(target)).toEqual({ items: [], hasMore: false })
  expect(await elmino.listThreads(target)).toEqual({ items: [], hasMore: false })
  expect(provider).toHaveBeenCalledTimes(2)
  await elmino.close()
  expect(release).toHaveBeenCalledOnce()
})

test('恢复失败仍释放借用，释放错误不会盖过主错误或阻止下一次重试', async () => {
  const { root, store } = await createEngineStore()
  const failure = new ElminoError('BAD_REQUEST', '测试持久化恢复失败')
  const cleanupFailure = new Error('测试借用释放失败')
  const recovery = vi.spyOn(store.threads, 'listAll').mockRejectedValueOnce(failure)
  const release = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(cleanupFailure)
    .mockResolvedValue(undefined)
  const provider = vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store, release })
  const errors: unknown[] = []
  const elmino = defineElmino({
    agents: { writer },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: () => { throw new Error('列表不应解析模型') },
    onError: (error) => {
      errors.push(error)
    },
  })
  onTestFinished(async () => {
    recovery.mockRestore()
    await elmino.close()
    await disposeEngineStore(root, store)
  })
  const target = { agentId: 'writer', workspaceId: 'fixed' }
  await expect(elmino.listThreads(target)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: failure.message })
  expect(release).toHaveBeenCalledOnce()
  expect(errors.flatMap(error => error instanceof AggregateError ? error.errors : [error])).toContain(cleanupFailure)
  expect(await elmino.listThreads(target)).toEqual({ items: [], hasMore: false })
  expect(provider).toHaveBeenCalledTimes(2)
  await elmino.close()
  expect(release).toHaveBeenCalledTimes(2)
})

test('已打开作用域释放失败会拒绝关闭，仍关闭事件流并保持关闭结果幂等', async () => {
  const { root, store } = await createEngineStore()
  const failure = new Error('测试已打开借用释放失败')
  const release = vi.fn(async () => {
    await store.close()
    throw failure
  })
  const provider = vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store, release })
  const elmino = defineElmino({
    agents: { writer },
    workspace: { id: 'fixed', rootDir: root, store: provider },
    models: () => { throw new Error('订阅不应解析模型') },
  })
  onTestFinished(async () => {
    await elmino.close().catch(() => undefined)
    await disposeEngineStore(root, store)
  })
  const ended = Promise.withResolvers<void>()
  elmino.subscribe({ onEvent: () => {}, onClose: () => ended.resolve() })
  await elmino.openWorkspace({ agentId: 'writer', workspaceId: 'fixed' })
  const closing = elmino.close()
  expect(elmino.close()).toBe(closing)
  await expect(closing).rejects.toMatchObject({ errors: [failure] })
  await ended.promise
  expect(release).toHaveBeenCalledOnce()
  await expect(store.threads.listAll()).rejects.toThrow()
})
