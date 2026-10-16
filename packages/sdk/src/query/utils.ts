import type { ApiClient } from '@elmino/api'
import type { RouterUtils } from '@orpc/tanstack-query'
import type { Client } from '../client/client'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

/** Query utilities 只需要已存在的客户端与服务身份 */
export type QueryApi = Pick<Client, 'baseUrl' | 'rpc'>

/** 复用 oRPC 提供的查询与变更定义，不建立第二套缓存 */
export type ApiQueryUtils = RouterUtils<ApiClient>

/**
 * 以服务地址隔离缓存键，查询和变更仍使用原类型化客户端
 */
export function createApiQueryUtils(client: QueryApi): ApiQueryUtils {
  return createTanstackQueryUtils(client.rpc, { path: [client.baseUrl] })
}
