/* eslint antfu/no-top-level-await: off -- 仓库外可选适配器依次编译并运行真实消费程序 */
import type { ClientThread, ClientThreadSnapshot, Composer, ComposerSnapshot } from '@elmino/sdk'
import type { ApiQueryUtils, QueryApi } from '@elmino/sdk/query'
import { Client } from '@elmino/sdk'
import { createApiQueryUtils } from '@elmino/sdk/query'
import { useComposer, useThread } from '@elmino/sdk/react'
import { QueryClient } from '@tanstack/query-core'

/** Hook 只校验正式入口和类型，不在 React 组件外调用 Hook */
const readThread: (thread: ClientThread) => ClientThreadSnapshot = useThread
/** Composer 适配器继续消费同一个无界面状态所有者 */
const readComposer: (composer: Composer) => ComposerSnapshot = useComposer
if (typeof readThread !== 'function' || typeof readComposer !== 'function')
  throw new Error('React 可选入口缺少公开 Hook')

/** 确定性传输覆盖真实 QueryClient，不访问外部 Server */
const requests: Request[] = []
/** 查询调用始终经过标准 Fetch 与 SDK 的动态传输 */
const fetch: typeof globalThis.fetch = (input, init) => {
  // 每个请求保留真实 URL，验收挂载前缀与缓存是否正确复用
  const request = new Request(input, init)
  requests.push(request)
  return Promise.resolve(Response.json({ json: { status: 'ok' } }))
}
/** 公开查询适配器只借用稳定地址与类型化 RPC */
const client: QueryApi = Client.create({ baseUrl: 'https://query.example/prefix', fetch })
/** 类型化 utilities 不依赖应用内部查询封装或源码路径 */
const api: ApiQueryUtils = createApiQueryUtils(client)
/** 第二个服务即便 procedure 相同，也必须使用独立缓存键 */
const other = createApiQueryUtils(Client.create({ baseUrl: 'https://other.example/prefix', fetch }))
/** 查询配置交给正式 TanStack QueryClient 执行，保持类型推导与缓存能力 */
const options = api.meta.health.queryOptions({ input: {} })
if (JSON.stringify(options.queryKey) === JSON.stringify(other.meta.health.queryOptions({ input: {} }).queryKey))
  throw new Error('不同服务的查询配置没有隔离缓存键')

/** 验收不保留后台计时器或自动重试，结束后由 finally 清空缓存 */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
try {
  // 返回值必须保留契约中的 ok 字面量，避免声明产物把查询结果退化为 unknown
  const first: { status: 'ok' } = await queryClient.fetchQuery(options)
  const cached: { status: 'ok' } = await queryClient.fetchQuery(options)
  if (first.status !== 'ok' || cached.status !== 'ok' || requests.length !== 1
    || requests[0]?.url !== 'https://query.example/prefix/rpc/meta/health') {
    throw new Error('可选 Query 入口没有通过真实 SDK 请求或复用查询缓存')
  }
}
finally {
  queryClient.clear()
}
