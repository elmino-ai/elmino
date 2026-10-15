import type { NestedClient } from '@orpc/client'
import type { RequestTransport } from '../core/request'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { BatchLinkPlugin } from '@orpc/client/plugins'

/** -------------------- 类型 -------------------- */
/** oRPC HTTP client 的批处理边界 */
export interface OrpcClientOptions {
  /** 按 procedure 路径排除不能进入 batch 的请求 */
  batch?: {
    /** 返回 true 时当前请求独立发送 */
    exclude?: (path: readonly string[]) => boolean
  }
}

/** -------------------- 核心函数 -------------------- */
/**
 * 使用统一鉴权传输创建类型化 oRPC 客户端
 */
export function createOrpcClient<TClient extends NestedClient<any>>(
  transport: RequestTransport,
  options: OrpcClientOptions = {},
) {
  const link = new RPCLink({
    url: transport.rpcBaseUrl ?? transport.baseUrl,
    fetch: (request, init) => transport.rawFetch(request, init),
    plugins: [
      new BatchLinkPlugin({
        exclude: ({ path }) => options.batch?.exclude?.(path) ?? false,
        groups: [{ condition: () => true, context: {} }],
        maxSize: 10,
        maxUrlLength: 2_048,
      }),
    ],
  })

  return createORPCClient<TClient>(link)
}
