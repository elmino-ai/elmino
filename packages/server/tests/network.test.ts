import type { ServerAuthorization } from '../src/index'
import { Client } from '@elmino/sdk'
import { expect, onTestFinished, test, vi } from 'vitest'
import { AgentServer } from '../src/index'
import { listen } from '../src/node/index'
import { createServerHarness } from './support/server'

/** 健康与鉴权请求不应打开任何工作区或模型资源 */
function createEmptyServer(authorize?: (context: ServerAuthorization) => boolean | Promise<boolean>) {
  return AgentServer.create({
    agents: {},
    authorize,
    resolveWorkspace: () => { throw new Error('健康请求不应打开工作区') },
    resolveModel: () => { throw new Error('健康请求不应装配模型') },
  })
}

test('真实随机端口提供 SDK 健康检查并拒绝缺少凭据的请求', async () => {
  const server = createEmptyServer(({ request }) => request.headers.get('authorization') === 'Bearer fake-network-key')
  const listener = await listen({ server })
  onTestFinished(async () => {
    await server.close()
    await listener.close()
  })
  const client = Client.create({ baseUrl: listener.url, apiKey: 'fake-network-key' })

  await expect(client.rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
  await expect(client.rpc.agent.list({})).resolves.toEqual([])
  await expect(Client.create({ baseUrl: listener.url }).rpc.meta.health({})).rejects.toMatchObject({ status: 401 })
})

test('一个真实 HTTP batch 中的每个 procedure 独立鉴权', async () => {
  const authorize = vi.fn(({ path, request }: ServerAuthorization) => (
    request.headers.get('authorization') === 'Bearer fake-network-key' && path[0] === 'meta'
  ))
  const server = createEmptyServer(authorize)
  const listener = await listen({ server })
  onTestFinished(async () => {
    await server.close()
    await listener.close()
  })
  const requests: Request[] = []
  const client = Client.create({
    baseUrl: listener.url,
    apiKey: 'fake-network-key',
    fetch: (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return globalThis.fetch(request)
    },
  })
  const results = await Promise.allSettled([client.rpc.meta.health({}), client.rpc.agent.list({})])

  expect(requests).toHaveLength(1)
  expect(requests[0]?.headers.get('x-orpc-batch')).toBeTruthy()
  expect(authorize.mock.calls.map(([context]) => [...context.path].join('.')).sort()).toEqual(['agent.list', 'meta.health'])
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'ok' } })
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 401 } })
})

test('授权等待期间关闭服务，已进入的网络请求返回服务关闭而非成功', async () => {
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const server = createEmptyServer(() => {
    started.resolve()
    return gate.promise.then(() => true)
  })
  const listener = await listen({ server })
  onTestFinished(async () => {
    gate.resolve()
    await server.close()
    await listener.close()
  })
  const client = Client.create({ baseUrl: listener.url })
  const response = expect(client.rpc.meta.health({})).rejects.toMatchObject({ status: 503 })
  await started.promise
  const closing = server.close()
  gate.resolve()

  await response
  await closing
})

test('关闭后的 HTTP 返回 503，监听关闭幂等并允许重新绑定同一端口', async () => {
  const server = createEmptyServer()
  const listener = await listen({ server })
  onTestFinished(async () => {
    await server.close()
    await listener.close()
  })
  const port = Number(new URL(listener.url).port)
  await server.close()
  const response = await fetch(`${listener.url}/rpc/meta/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: {} }),
  })
  expect(response.status).toBe(503)
  await expect(Client.create({ baseUrl: listener.url }).rpc.meta.health({})).rejects.toMatchObject({
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  })
  const closing = listener.close()
  expect(listener.close()).toBe(closing)
  await closing
  const nextServer = createEmptyServer()
  const nextListener = await listen({ server: nextServer, port })
  onTestFinished(async () => {
    await nextServer.close()
    await nextListener.close()
  })
  await expect(Client.create({ baseUrl: nextListener.url }).rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
})

test('监听端口冲突保留操作系统错误，不产生无法关闭的后台监听', async () => {
  const server = createEmptyServer()
  const listener = await listen({ server })
  onTestFinished(async () => {
    await server.close()
    await listener.close()
  })

  await expect(listen({ server, port: Number(new URL(listener.url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await expect(Client.create({ baseUrl: listener.url }).rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
})

test('真实空闲 SSE 取消释放连接，Server 关闭也能结束新的空闲订阅', async () => {
  const harness = await createServerHarness()
  const listener = await listen({ server: harness.server })
  onTestFinished(() => listener.close())
  const completedStreams: Promise<void>[] = []
  const signals: AbortSignal[] = []
  const client = Client.create({
    baseUrl: listener.url,
    retry: { initialDelayMs: 1_000 },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      signals.push(request.signal)
      const response = await globalThis.fetch(request)
      if (!response.body)
        throw new Error('SSE 缺少 HTTP 正文')
      const reader = response.body.getReader()
      const completed = Promise.withResolvers<void>()
      completedStreams.push(completed.promise)
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              completed.resolve()
              controller.close()
            }
            else {
              controller.enqueue(next.value)
            }
          }
          catch (error) {
            completed.resolve()
            controller.error(error)
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          }
          finally {
            completed.resolve()
          }
        },
      })
      return new Response(body, { status: response.status, headers: response.headers })
    },
  })
  const connected = Promise.withResolvers<void>()
  const unsubscribe = client.subscribe({ agentId: 'alpha', workspaceId: 'primary' }, {
    onReset: () => connected.resolve(),
    onEvent: () => {},
    onError: error => connected.reject(error),
  })
  onTestFinished(unsubscribe)
  await connected.promise
  unsubscribe()
  await completedStreams[0]
  expect(signals[0]?.aborted).toBe(true)
  // 第二条订阅保持空闲，让 Server 自己结束 Hub 与 HTTP 正文
  const nextConnected = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<unknown>()
  const stop = client.subscribe({ agentId: 'alpha', workspaceId: 'primary' }, {
    onReset: () => nextConnected.resolve(),
    onEvent: () => {},
    onError: error => ended.resolve(error),
  })
  onTestFinished(stop)
  await nextConnected.promise
  await harness.server.close()
  await ended.promise
  await completedStreams[1]
  stop()
})
