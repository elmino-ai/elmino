import type { ApiClient, RuntimeEventSubscribeInput } from '@elmino/api'
import type { RequestClient, RequestTransport } from '@elmino/request'
import type { ClientOptions, RuntimeEventSubscribeHandlers } from './types'
import { RPC_PATH } from '@elmino/api/paths'
import { createRequest } from '@elmino/request'
import { createOrpcClient } from '@elmino/request/orpc'
import { subscribeRuntimeEvents } from '../events/subscribe'

/** 类型化 API、宿主自定义 HTTP 传输和可恢复的运行事件订阅 */
export class Client {
  /** 规范化后的服务地址，包含宿主挂载前缀 */
  public readonly baseUrl: string
  /** 全部 API 方法直接通过同一个类型化客户端调用 */
  public readonly rpc: ApiClient
  /** 原生 HTTP 端点与 oRPC 共用的鉴权传输 */
  private readonly _request: RequestClient
  /** 当前客户端持有的事件重连配置快照 */
  private readonly _retry: ClientOptions['retry']

  /** 创建纯浏览器或 Node.js API 客户端 */
  public static create(options: ClientOptions): Client {
    return new Client(options)
  }

  /** 绑定服务地址、动态鉴权和宿主 Fetch，不读取本地配置 */
  private constructor(options: ClientOptions) {
    const { apiKey, baseUrl, fetch, headers: inputHeaders } = options
    const request = createRequest({
      baseUrl,
      system: 'elmino',
      fetch,
      headers: async () => {
        const headers = new Headers(apiKey ? { authorization: `Bearer ${apiKey}` } : undefined)
        const overrides = typeof inputHeaders === 'function' ? await inputHeaders() : inputHeaders
        for (const [name, value] of new Headers(overrides))
          headers.set(name, value)
        return headers
      },
    })
    this.baseUrl = request.baseUrl
    this._request = request
    this._retry = options.retry ? { ...options.retry } : undefined
    this.rpc = createOrpcClient<ApiClient>(request.withBaseUrl(`${request.baseUrl}${RPC_PATH}`), {
      batch: { exclude: path => path[0] === 'events' },
    })
  }

  /** 返回与当前服务共用动态鉴权、但具有独立路径前缀的原生 HTTP 传输 */
  public transport(basePath: `/${string}`): RequestTransport {
    return this._request.withBaseUrl(`${this.baseUrl}${basePath}`)
  }

  /** 订阅单个 Agent 工作区的事实，可进一步只观察一个线程 */
  public subscribe(input: RuntimeEventSubscribeInput, handlers: RuntimeEventSubscribeHandlers): () => void {
    const scope = { ...input }
    return subscribeRuntimeEvents(options => this.rpc.events.subscribe(scope, options), handlers, this._retry)
  }
}
