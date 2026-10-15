import { expect, test } from 'vitest'
import { Client } from '../src/index'

test('RPC 使用规范化的宿主前缀并动态读取覆盖 API Key 的鉴权 Header', async () => {
  const requests: Request[] = []
  let token = 'first'
  const client = Client.create({
    baseUrl: 'https://service.example/mount/',
    apiKey: 'fake-default',
    headers: () => Promise.resolve({ 'authorization': `Bearer ${token}`, 'x-host': 'example' }),
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(Response.json({ json: { status: 'ok' } }))
    },
  })

  expect(client.baseUrl).toBe('https://service.example/mount')
  await expect(client.rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
  token = 'second'
  await client.rpc.meta.health({})
  expect(requests.map(request => request.url)).toEqual([
    'https://service.example/mount/rpc/meta/health',
    'https://service.example/mount/rpc/meta/health',
  ])
  expect(requests.map(request => request.headers.get('authorization'))).toEqual(['Bearer first', 'Bearer second'])
  expect(requests[1]?.headers.get('x-host')).toBe('example')
  expect(requests[0]?.redirect).toBe('manual')
})

test('原生传输与 RPC 共用凭据，跨域绝对地址不会携带默认鉴权', async () => {
  const requests: Request[] = []
  const client = Client.create({
    baseUrl: 'https://service.example/mount',
    apiKey: 'fake-default',
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(new Response())
    },
  })
  const transport = client.transport('/custom')

  await transport.fetch('/status')
  await transport.fetch('https://external.example/status')
  expect(requests[0]?.url).toBe('https://service.example/mount/custom/status')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer fake-default')
  expect(requests[1]?.headers.get('authorization')).toBeNull()
})

test('RPC 方法保留调用方的取消信号', async () => {
  let signal: AbortSignal | undefined
  const client = Client.create({
    baseUrl: 'https://service.example',
    fetch: (input, init) => {
      signal = new Request(input, init).signal
      return Promise.resolve(Response.json({ json: { status: 'ok' } }))
    },
  })
  const controller = new AbortController()

  await client.rpc.meta.health({}, { signal: controller.signal })
  expect(signal?.aborted).toBe(false)
  const reason = new Error('cancel client call')
  controller.abort(reason)
  expect(signal?.reason).toBe(reason)
})
