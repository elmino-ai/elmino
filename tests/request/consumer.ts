/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { RequestClient } from '@elmino/request'
import { createRequest, HttpError } from '@elmino/request'
import { createOrpcClient } from '@elmino/request/orpc'

/** 消费者自行定义业务客户端形状，无需安装 oRPC 服务端或契约包 */
type ExampleClient = Record<
  'echo' | 'wait',
  (input: { value: string }, options?: { signal?: AbortSignal }) => Promise<{ value: string }>
>

const requests: Request[] = []
const received = Promise.withResolvers<Request>()
const transport: RequestClient = createRequest({
  baseUrl: 'https://service.example/api',
  system: 'consumer',
  headers: () => Promise.resolve({ authorization: 'Bearer fake-consumer' }),
  fetch: (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.url.endsWith('/problem'))
      return Promise.resolve(Response.json({ message: 'conflict', code: 'CONFLICT' }, { status: 409 }))
    if (request.url.endsWith('/wait')) {
      received.resolve(request)
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
    return Promise.resolve(Response.json({ json: { value: 'published request' } }))
  },
})
const response = await transport.fetch('/items')
if (requests[0]?.url !== 'https://service.example/api/items'
  || requests[0]?.headers.get('authorization') !== 'Bearer fake-consumer') {
  throw new Error('公开 Fetch 无法绑定基础地址和动态鉴权')
}
if (JSON.stringify(await response.json()) !== JSON.stringify({ json: { value: 'published request' } }))
  throw new Error('公开 Fetch 无法保留响应正文')
await transport.fetch('https://external.example/items')
if (requests[1]?.headers.get('authorization') !== null)
  throw new Error('跨域请求继承了默认鉴权')
try {
  await transport.fetch('/problem')
  throw new Error('标准 Fetch 未拒绝错误响应')
}
catch (error) {
  if (!(error instanceof HttpError && error.system === 'consumer' && error.status === 409 && error.code === 'CONFLICT'))
    throw error
}
const raw = await transport.rawFetch('/problem')
if (raw.status !== 409 || raw.bodyUsed)
  throw new Error('rawFetch 提前消费了协议错误响应')

const client = createOrpcClient<ExampleClient>({ ...transport, rpcBaseUrl: 'https://service.example/rpc' }, {
  batch: { exclude: () => true },
})
if ((await client.echo({ value: 'input' })).value !== 'published request'
  || requests.at(-1)?.url !== 'https://service.example/rpc/echo'
  || requests.at(-1)?.redirect !== 'manual') {
  throw new Error('oRPC 子入口无法消费 rawFetch 或协议选项')
}
const controller = new AbortController()
const reason = new Error('cancel published RPC')
const pending = client.wait({ value: 'wait' }, { signal: controller.signal }).then(
  () => { throw new Error('oRPC 取消后仍返回成功') },
  (error) => {
    if (error !== reason)
      throw error
  },
)
const active = await received.promise
controller.abort(reason)
await pending
if (active.signal.reason !== reason)
  throw new Error('oRPC 未将原取消原因传到 Fetch')
