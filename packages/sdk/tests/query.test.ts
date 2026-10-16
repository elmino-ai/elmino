import { expect, test } from 'vitest'
import { Client } from '../src/client/client'
import { createApiQueryUtils } from '../src/query'

test('Query utilities沿用类型化RPC，并按服务地址隔离缓存键', async () => {
  // 两个远端即便使用相同的 procedure，也不能共用查询缓存键
  const requests: Request[] = []
  /** 用标准 HTTP 响应验证 queryFn 确实调用原 RPC */
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(new Request(input, init))
    return Promise.resolve(Response.json({ json: { status: 'ok' } }))
  }
  const first = createApiQueryUtils(Client.create({ baseUrl: 'https://one.example', fetch }))
  const second = createApiQueryUtils(Client.create({ baseUrl: 'https://two.example', fetch }))
  const options = first.meta.health.queryOptions({ input: {} })
  expect(options.queryKey).not.toEqual(second.meta.health.queryOptions({ input: {} }).queryKey)
  await expect(first.meta.health.call({})).resolves.toEqual({ status: 'ok' })
  expect(requests[0]!.url).toBe('https://one.example/rpc/meta/health')
})
