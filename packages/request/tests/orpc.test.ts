import type { RequestTransport } from '../src/index'
import { expect, test, vi } from 'vitest'
import { createRequest, HttpError } from '../src/index'
import { createOrpcClient } from '../src/orpc/index'

/** 使用业务形状定义客户端，不让测试依赖服务端契约包 */
type ExampleClient = Record<
  'echo' | 'standalone',
  (input: { value: string }, options?: { signal?: AbortSignal }) => Promise<{ value: string }>
>

test('oRPC 子入口使用 rawFetch 和独立 endpoint，转发手动重定向策略', async () => {
  let captured: Request | undefined
  const transport = createRequest({
    baseUrl: 'https://service.example/api',
    system: 'example',
    headers: { authorization: 'Bearer rpc' },
    fetch: (input, init) => {
      captured = new Request(input, init)
      return Promise.resolve(Response.json({ json: { value: 'rpc result' } }))
    },
  })
  const checkedFetch = vi.fn(() => Promise.reject(new Error('oRPC must use rawFetch')))
  const client = createOrpcClient<ExampleClient>({
    ...transport,
    rpcBaseUrl: 'https://service.example/rpc',
    fetch: checkedFetch,
  })

  await expect(client.echo({ value: 'input' })).resolves.toEqual({ value: 'rpc result' })
  expect(checkedFetch).not.toHaveBeenCalled()
  expect(captured?.url).toBe('https://service.example/rpc/echo')
  expect(captured?.redirect).toBe('manual')
  expect(captured?.headers.get('authorization')).toBe('Bearer rpc')
  expect(await captured?.json()).toEqual({ json: { value: 'input' } })
})

test('并行过程进入同一批次，排除的过程独立发送并各自正确解码', async () => {
  const requests: Request[] = []
  const transport = createRequest({
    baseUrl: 'https://service.example/rpc',
    system: 'example',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      const body = await request.json() as { json: { value: string } } | Array<{ body: { json: { value: string } } }>
      if (Array.isArray(body)) {
        return Response.json(body.map((item, index) => ({ index, status: 200, body: item.body })))
      }
      return Response.json(body)
    },
  })
  const excluded = vi.fn((path: readonly string[]) => path[0] === 'standalone')
  const client = createOrpcClient<ExampleClient>(transport, { batch: { exclude: excluded } })

  await expect(Promise.all([
    client.echo({ value: 'first' }),
    client.echo({ value: 'second' }),
    client.standalone({ value: 'separate' }),
  ])).resolves.toEqual([{ value: 'first' }, { value: 'second' }, { value: 'separate' }])
  expect(requests).toHaveLength(2)
  expect(requests.some(request => request.url.endsWith('/echo/__batch__'))).toBe(true)
  expect(requests.some(request => request.url.endsWith('/standalone'))).toBe(true)
  expect(excluded).toHaveBeenCalledWith(['standalone'])
})

test('oRPC 非成功响应由协议解码而非统一 Fetch 消费', async () => {
  const transport = createRequest({
    baseUrl: 'https://service.example/rpc',
    system: 'example',
    fetch: () => Promise.resolve(Response.json({
      json: { defined: true, code: 'CONFLICT', status: 409, message: 'rpc conflict', data: { id: 'item' } },
    }, { status: 409 })),
  })
  const client = createOrpcClient<ExampleClient>(transport)
  const pending = client.echo({ value: 'input' })

  await expect(pending).rejects.toMatchObject({ code: 'CONFLICT', status: 409, message: 'rpc conflict' })
  await expect(pending).rejects.not.toBeInstanceOf(HttpError)
})

test('oRPC 取消信号通过 rawFetch 传递且失败保持原原因', async () => {
  const received = Promise.withResolvers<Request>()
  const controller = new AbortController()
  const transport: RequestTransport = createRequest({
    baseUrl: 'https://service.example/rpc',
    system: 'example',
    fetch: (input, init) => {
      const request = new Request(input, init)
      received.resolve(request)
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    },
  })
  const client = createOrpcClient<ExampleClient>(transport, { batch: { exclude: () => true } })
  const reason = new Error('cancel rpc')
  const pending = expect(client.echo({ value: 'input' }, { signal: controller.signal })).rejects.toBe(reason)
  const request = await received.promise

  expect(request.signal.aborted).toBe(false)
  controller.abort(reason)
  await pending
  expect(request.signal.reason).toBe(reason)
})
