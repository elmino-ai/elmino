import { Client } from '@elmino/sdk'
import { Hono } from 'hono'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createEmptyServer, createServerHarness } from './support/server'

test('http 同步配置真实 Hono，宿主中间件和子路由与 REST、SDK 共用监听', async () => {
  const http = vi.fn((app: Hono) => {
    app.use('*', async (context, next) => {
      await next()
      context.header('X-Host', 'elmino')
    })
    const host = new Hono().get('/ping', context => context.json({ pong: true }))
    app.route('/host', host)
  })
  const server = createEmptyServer({ http })
  onTestFinished(() => server.close())
  expect(http).toHaveBeenCalledOnce()
  const url = await server.start({ port: 0, shutdownSignals: false })
  const custom = await fetch(`${url}/host/ping`)
  expect(custom.headers.get('x-host')).toBe('elmino')
  expect(await custom.json()).toEqual({ pong: true })
  const rest = await fetch(`${url}/api/health`)
  expect(rest.headers.get('x-host')).toBe('elmino')
  expect(await rest.json()).toEqual({ status: 'ok' })
  const client = Client.create({
    baseUrl: url,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      expect(response.headers.get('x-host')).toBe('elmino')
      return response
    },
  })
  await expect(client.rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
  expect((await fetch(`${url}/missing`)).status).toBe(404)
  expect(http).toHaveBeenCalledOnce()
})

test('Hono 鉴权中间件先于 API，内置 apiKey 仍逐项检查，自定义接口由宿主授权', async () => {
  const server = createEmptyServer({
    apiKey: 'fake-http-key',
    http: (app) => {
      app.use('*', async (context, next) => {
        if (context.req.header('x-session') !== 'host-session')
          return context.json({ error: '宿主拒绝访问' }, 403)
        await next()
        return undefined
      })
      app.get('/host', context => context.json({ ready: true }))
    },
  })
  onTestFinished(() => server.close())
  expect((await server.fetch(new Request('http://elmino.test/api/health'))).status).toBe(403)
  const headers = { 'x-session': 'host-session' }
  expect((await server.fetch(new Request('http://elmino.test/api/health', { headers }))).status).toBe(401)
  expect((await server.fetch(new Request('http://elmino.test/api/health', {
    headers: { ...headers, authorization: 'Bearer fake-http-key' },
  }))).status).toBe(200)
  const custom = await server.fetch(new Request('http://elmino.test/host', { headers }))
  expect(custom.status).toBe(200)
  expect(await custom.json()).toEqual({ ready: true })
})

test.each([
  { endpoint: '/api/health', method: 'GET' },
  { endpoint: '/rpc/meta/health', method: 'POST' },
  { endpoint: '/host', method: 'PUT' },
])('Hono CORS 覆盖 $method $endpoint 的预检、鉴权失败和成功响应', async ({ endpoint, method }) => {
  const origin = 'http://localhost:5173'
  const authorize = vi.fn(() => true)
  const server = createEmptyServer({
    apiKey: 'fake-cors-key',
    authorize,
    corsOrigins: [origin],
    http: app => app.put('/host', context => context.json({ ok: true })),
  })
  onTestFinished(() => server.close())
  const preflight = await server.fetch(new Request(`http://elmino.test${endpoint}`, {
    method: 'OPTIONS',
    headers: {
      'origin': origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,last-event-id,x-orpc-batch',
    },
  }))
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
  expect(preflight.headers.get('access-control-allow-methods')).toContain(method)
  expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('last-event-id')
  expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-orpc-batch')
  expect(preflight.headers.get('vary')).toContain('Origin')
  expect(authorize).not.toHaveBeenCalled()
  const request = (allowedOrigin: string, authenticated: boolean) => new Request(`http://elmino.test${endpoint}`, {
    method,
    headers: {
      'origin': allowedOrigin,
      'content-type': 'application/json',
      ...(authenticated ? { authorization: 'Bearer fake-cors-key' } : {}),
    },
    body: endpoint.startsWith('/rpc') ? JSON.stringify({ json: {} }) : undefined,
  })
  const denied = await server.fetch(request(origin, false))
  expect(denied.status).toBe(endpoint === '/host' ? 200 : 401)
  expect(denied.headers.get('access-control-allow-origin')).toBe(origin)
  const response = await server.fetch(request(origin, true))
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  expect(response.headers.get('access-control-expose-headers')).toBe('Content-Type')
  expect(response.headers.get('vary')).toContain('Origin')
  expect((await server.fetch(request('https://untrusted.test', true))).headers.get('access-control-allow-origin')).toBeNull()
})

test('未配置 corsOrigins 时不开放跨域，不因接入 Hono 自动允许任意来源', async () => {
  const server = createEmptyServer()
  onTestFinished(() => server.close())
  const response = await server.fetch(new Request('http://elmino.test/api/health', {
    headers: { origin: 'https://untrusted.test' },
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
})

test('关闭等待已进入的自定义路由，新的自定义请求返回 503', async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const handle = vi.fn(async () => {
    entered.resolve()
    await gate.promise
    return new Response('done')
  })
  const server = createEmptyServer({ http: app => app.get('/slow', handle) })
  onTestFinished(async () => {
    gate.resolve()
    await server.close()
  })
  const response = server.fetch(new Request('http://elmino.test/slow'))
  await entered.promise
  let closed = false
  const closing = server.close().then(() => {
    closed = true
  })
  expect((await server.fetch(new Request('http://elmino.test/slow'))).status).toBe(503)
  expect(closed).toBe(false)
  expect(handle).toHaveBeenCalledOnce()
  gate.resolve()
  expect(await (await response).text()).toBe('done')
  await closing
  expect(closed).toBe(true)
})

test('自定义路由异常通过 Hono 错误处理报告，观察器失败不破坏响应或 CORS', async () => {
  const failure = new Error('测试宿主路由失败')
  const onError = vi.fn(() => {
    throw new Error('测试观察器失败')
  })
  const server = createEmptyServer({
    corsOrigins: ['http://localhost:5173'],
    onError,
    http: (app) => {
      app.get('/fail', () => {
        throw failure
      })
    },
  })
  onTestFinished(() => server.close())
  const response = await server.fetch(new Request('http://elmino.test/fail', { headers: { origin: 'http://localhost:5173' } }))
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: '服务请求失败' })
  expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
})

test('真实 SSE 经过 Hono CORS 后保留正文、游标和取消行为', async () => {
  const origin = 'http://localhost:5173'
  const harness = await createServerHarness({ corsOrigins: [origin] })
  const url = await harness.server.start({ port: 0, shutdownSignals: false })
  const query = new URLSearchParams({ agentId: 'alpha', workspaceId: 'primary' })
  const response = await fetch(`${url}/api/events?${query}`, { headers: { origin } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  onTestFinished(() => reader.cancel())
  const opening = await reader.read()
  expect(opening.value).toContain('stream.reset')
  expect(opening.value).toMatch(/^id:/m)
  await reader.cancel()
  await harness.server.close()
  expect(harness.modelRequests).toEqual([])
})
