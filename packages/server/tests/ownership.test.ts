import type { RuntimeStoreProvider } from '@elmino/store'
import { defineElmino } from '@elmino/core'
import { Client } from '@elmino/sdk'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createEngineStore, disposeEngineStore } from '../../engine/tests/support/engine'
import { createModel, response } from '../../engine/tests/support/model'
import { defineServer } from '../src/index'
import { createEmptyServer, createGatedModel, createServerHarness, threadTarget } from './support/server'

test('两个 Server 共用同一个 Elmino，关闭其中一个不打断任务，另一个能继续读取结果', async () => {
  const harness = await createServerHarness()
  const second = defineServer({ elmino: harness.elmino })
  onTestFinished(() => second.close())
  const firstUrl = await harness.server.start({ port: 0, shutdownSignals: false })
  const secondUrl = await second.start({ port: 0, shutdownSignals: false })
  expect(second.elmino).toBe(harness.server.elmino)
  expect(second.elmino.getAgent('alpha')).toBe(harness.elmino.getAgent('alpha'))
  const model = createGatedModel('共享实例执行完成')
  harness.models.push(model.model)
  const request = harness.request()
  await Client.create({ baseUrl: firstUrl }).rpc.turn.create(request)
  await model.entered
  await harness.server.close()
  expect(harness.elmino.closed).toBe(false)
  expect(model.signal?.aborted).toBe(false)
  const client = Client.create({ baseUrl: secondUrl })
  expect((await client.rpc.thread.get(threadTarget(request))).runtime.status).toBe('running')
  model.release()
  await vi.waitFor(async () => {
    expect((await client.rpc.thread.get(threadTarget(request))).turns).toMatchObject([{ status: 'completed' }])
  })
  expect(harness.modelRequests).toHaveLength(1)
  await harness.elmino.close()
  await expect(client.rpc.meta.health({})).rejects.toMatchObject({ status: 503 })
})

test('Server 端口冲突只清理自己的接入，传入的 Elmino 仍可本地执行', async () => {
  const harness = await createServerHarness()
  const owner = createEmptyServer()
  const failed = defineServer({ elmino: harness.elmino })
  onTestFinished(async () => {
    await Promise.all([owner.close(), failed.close()])
  })
  const url = await owner.start({ port: 0, shutdownSignals: false })
  await expect(failed.start({ port: Number(new URL(url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  expect(harness.elmino.closed).toBe(false)
  harness.models.push(createModel([response([{ type: 'text', text: '核心不受端口冲突影响' }])]).model)
  const result = await harness.elmino.run({ agentId: 'alpha', workspaceId: 'primary', input: '本地执行' })
  expect(result.status).toBe('completed')
})

test('Elmino 释放租约失败不妨碍 Server 独立关闭监听', async () => {
  const harness = await createServerHarness()
  const { root, store } = await createEngineStore()
  const failure = new Error('测试租约释放失败')
  const release = vi.fn<() => Promise<void>>().mockRejectedValue(failure)
  const elmino = defineElmino({
    agents: { alpha: harness.elmino.getAgent('alpha') },
    workspace: { id: 'primary', rootDir: root, store: vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store, release }) },
    models: () => { throw new Error('查询不应调用模型') },
  })
  const server = defineServer({ elmino })
  onTestFinished(async () => {
    await Promise.allSettled([server.close(), elmino.close()])
    await disposeEngineStore(root, store)
  })
  const url = await server.start({ port: 0, shutdownSignals: false })
  await Client.create({ baseUrl: url }).rpc.thread.list({ agentId: 'alpha', workspaceId: 'primary' })
  await expect(elmino.close()).rejects.toMatchObject({ errors: [failure] })
  await server.close()
  expect(release).toHaveBeenCalledOnce()
  await expect(fetch(`${url}/api/health`)).rejects.toThrow()
})

test('订阅打开工作区期间关闭 Server，不创建迟到事件流，也不关闭 Elmino', async () => {
  const harness = await createServerHarness()
  const { root, store } = harness.stores.primary
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const elmino = defineElmino({
    agents: { alpha: harness.elmino.getAgent('alpha') },
    workspace: {
      id: 'primary',
      rootDir: root,
      store: async () => {
        entered.resolve()
        await gate.promise
        return { store, release: async () => {} }
      },
    },
    models: () => { throw new Error('订阅不应调用模型') },
  })
  const server = defineServer({ elmino })
  onTestFinished(async () => {
    gate.resolve()
    await Promise.allSettled([server.close(), elmino.close()])
  })
  const client = Client.create({ baseUrl: 'https://elmino.test', fetch: (input, init) => server.fetch(new Request(input, init)) })
  const pending = client.rpc.events.subscribe({ agentId: 'alpha', workspaceId: 'primary' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  await entered.promise
  const closing = server.close()
  gate.resolve()
  await rejected
  await closing
  expect(elmino.closed).toBe(false)
  expect(await elmino.listThreads({ agentId: 'alpha', workspaceId: 'primary' })).toEqual({ items: [], hasMore: false })
})
