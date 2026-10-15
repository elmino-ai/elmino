import { afterEach, expect, test, vi } from 'vitest'
import { createRequest } from '../src/index'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('相对路径保留服务前缀，成功响应不被预读取', async () => {
  const requests: Request[] = []
  const response = Response.json({ value: 'ok' })
  const client = createRequest({
    baseUrl: 'https://service.example/api/',
    system: 'example',
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(response)
    },
  })

  expect(client.baseUrl).toBe('https://service.example/api')
  expect(await client.fetch('/items?scope=current')).toBe(response)
  expect(requests[0]?.url).toBe('https://service.example/api/items?scope=current')
  expect(response.bodyUsed).toBe(false)
  expect(await response.json()).toEqual({ value: 'ok' })
})

test('动态 Header 每次读取且调用点覆盖，跨域不加载默认鉴权', async () => {
  const requests: Request[] = []
  let token = 'first'
  const headers = vi.fn(() => Promise.resolve({ 'authorization': `Bearer ${token}`, 'x-service': 'example' }))
  const client = createRequest({
    baseUrl: 'https://service.example/api',
    system: 'example',
    headers,
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(new Response())
    },
  })

  await client.fetch('first')
  token = 'second'
  await client.fetch('second', { headers: { authorization: 'Bearer explicit' } })
  await client.fetch('https://external.example/items', { headers: { accept: 'application/json' } })
  await client.fetch('https://external.example/explicit', { headers: { authorization: 'Bearer caller-owned' } })
  expect(headers).toHaveBeenCalledTimes(2)
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer first')
  expect(requests[1]?.headers.get('authorization')).toBe('Bearer explicit')
  expect(requests[1]?.headers.get('x-service')).toBe('example')
  expect(requests[2]?.headers.get('authorization')).toBeNull()
  expect(requests[2]?.headers.get('x-service')).toBeNull()
  expect(requests[2]?.headers.get('accept')).toBe('application/json')
  expect(requests[3]?.headers.get('authorization')).toBe('Bearer caller-owned')
})

test('派生基础地址复用动态策略并按新的 origin 决定鉴权', async () => {
  let captured: Request | undefined
  const client = createRequest({
    baseUrl: 'https://first.example/api',
    system: 'example',
    headers: () => ({ authorization: 'Bearer current' }),
    fetch: (input, init) => {
      captured = new Request(input, init)
      return Promise.resolve(new Response())
    },
  })
  const derived = client.withBaseUrl('https://second.example/rpc')

  await derived.fetch('items')
  expect(derived.system).toBe(client.system)
  expect(captured?.url).toBe('https://second.example/rpc/items')
  expect(captured?.headers.get('authorization')).toBe('Bearer current')
})

test('Request 流体在注入 Header 后保持流式且不提前消费', async () => {
  const received = Promise.withResolvers<Request>()
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller
    },
  })
  const input = new Request('https://service.example/upload', {
    method: 'POST',
    body,
    headers: { 'x-input': 'preserved' },
    ...{ duplex: 'half' },
  })
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    headers: { authorization: 'Bearer upload' },
    fetch: (request, init) => {
      const forwarded = new Request(request, init)
      received.resolve(forwarded)
      return Promise.resolve(new Response(forwarded.body))
    },
  })
  const pending = client.rawFetch(input)
  const forwarded = await received.promise

  expect(forwarded.method).toBe('POST')
  expect(forwarded.bodyUsed).toBe(false)
  expect(forwarded.headers.get('x-input')).toBe('preserved')
  expect(forwarded.headers.get('authorization')).toBe('Bearer upload')
  bodyController.enqueue(new TextEncoder().encode('streamed payload'))
  bodyController.close()
  expect(await (await pending).text()).toBe('streamed payload')
})

test('取消穿过 Request 重建传给底层 Fetch 并保留原原因', async () => {
  const received = Promise.withResolvers<Request>()
  const controller = new AbortController()
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    fetch: (input, init) => {
      const forwarded = new Request(input, init)
      received.resolve(forwarded)
      return new Promise((_, reject) => {
        forwarded.signal.addEventListener('abort', () => reject(forwarded.signal.reason), { once: true })
      })
    },
  })
  const reason = new Error('caller cancelled')
  const pending = expect(client.fetch('/slow', { signal: controller.signal })).rejects.toBe(reason)
  const forwarded = await received.promise

  expect(forwarded.signal.aborted).toBe(false)
  controller.abort(reason)
  await pending
  expect(forwarded.signal.reason).toBe(reason)
})

test('默认 Fetch 在请求发生时读取，网络异常不包装成 HTTP 错误', async () => {
  const client = createRequest({ baseUrl: 'https://service.example', system: 'example' })
  const reason = new Error('network failed')
  const fetch = vi.fn(() => Promise.reject(reason))
  vi.stubGlobal('fetch', fetch)

  await expect(client.fetch('/items')).rejects.toBe(reason)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('浏览器相对基础地址使用页面 origin，Node 不隐式选择服务', () => {
  vi.stubGlobal('location', undefined)
  expect(() => createRequest({ baseUrl: '/api', system: 'example' })).toThrow(TypeError)
  vi.stubGlobal('location', { origin: 'https://browser.example' })
  expect(createRequest({ baseUrl: '/api/', system: 'example' }).baseUrl).toBe('https://browser.example/api')
  expect(createRequest({ baseUrl: '', system: 'example' }).baseUrl).toBe('https://browser.example')
})
