import type { ApiClient, ApiThreadListInput, RuntimeEventSubscribeInput } from '@elmino/api'
import type { RequestClient, RequestTransport } from '@elmino/request'
import type { ClientRunOptions, ClientRunResult } from '../run/types'
import type { ClientThread, ClientThreadOptions } from '../thread/types'
import type { ClientOptions, RuntimeEventSubscribeHandlers } from './types'
import { RPC_PATH } from '@elmino/api/paths'
import { createRequest } from '@elmino/request'
import { createOrpcClient } from '@elmino/request/orpc'
import { createEventChannels } from '../events/channel'
import { subscribeRuntimeEvents } from '../events/subscribe'
import { ThreadClient } from '../thread/thread'

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
  /** 按 Agent 与工作区复用事件连接，供会话执行和状态观察共享 */
  private readonly _channels: ReturnType<typeof createEventChannels>

  /**
   * 创建纯浏览器或 Node.js API 客户端
   */
  public static create(options: ClientOptions): Client {
    return new Client(options)
  }

  /**
   * 绑定服务地址、动态鉴权和宿主 Fetch，不读取本地配置
   */
  private constructor(options: ClientOptions) {
    // 拆出传输配置，避免客户端直接依赖宿主环境变量
    const { apiKey, baseUrl, fetch, headers: inputHeaders } = options
    // 保存统一的地址规范化、鉴权和 Fetch 传输能力
    const request = createRequest({
      baseUrl,
      system: 'elmino',
      fetch,
      /** 每次请求重新合并凭据和宿主 Header，支持动态鉴权配置 */
      headers: async () => {
        // 为本次请求创建独立 Header，动态配置不会污染其他请求
        const headers = new Headers(apiKey ? { authorization: `Bearer ${apiKey}` } : undefined)
        // 读取宿主本次请求的额外 Header，显式值可覆盖默认凭据
        const overrides = typeof inputHeaders === 'function' ? await inputHeaders() : inputHeaders
        // 逐项应用宿主 Header 的名称和值，保留标准 Headers 的规范化结果
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
    this._channels = createEventChannels((input, handlers) => this.subscribe(input, handlers), this._retry)
  }

  /**
   * 返回与当前服务共用动态鉴权、但具有独立路径前缀的原生 HTTP 传输
   */
  public transport(basePath: `/${string}`): RequestTransport {
    return this._request.withBaseUrl(`${this.baseUrl}${basePath}`)
  }

  /**
   * 提交远程任务并等待本轮终态，自动处理订阅、重连补齐和清理
   */
  public run(options: ClientRunOptions): Promise<ClientRunResult> {
    return this.thread(options).run(options.input, options)
  }

  /**
   * 固定 Agent、工作区和会话，后续调用不必重复传入身份
   */
  public thread(options: ClientThreadOptions): ClientThread {
    return ThreadClient.create({ rpc: this.rpc, subscribe: this._channels.subscribe }, options)
  }

  /**
   * 读取已注册 Agent 的公开说明，不加载执行资源
   */
  public listAgents(options: { signal?: AbortSignal } = {}): ReturnType<ApiClient['agent']['list']> {
    return this.rpc.agent.list({}, options)
  }

  /**
   * 查询会话列表；保留服务端前缀数量限制，不伪装成尚未实现的游标分页
   */
  public listThreads(input: ApiThreadListInput, options: { signal?: AbortSignal } = {}): ReturnType<ApiClient['thread']['list']> {
    return this.rpc.thread.list(input, options)
  }

  /**
   * 检查服务能否响应，不代表外部模型可用
   */
  public health(options: { signal?: AbortSignal } = {}): ReturnType<ApiClient['meta']['health']> {
    return this.rpc.meta.health({}, options)
  }

  /**
   * 订阅单个 Agent 工作区的事实，可进一步只观察一个线程
   */
  public subscribe(input: RuntimeEventSubscribeInput, handlers: RuntimeEventSubscribeHandlers): () => void {
    // 冻结本次订阅归属，避免调用方修改原对象后切换目标
    const scope = { ...input }
    return subscribeRuntimeEvents(options => this.rpc.events.subscribe(scope, options), handlers, this._retry)
  }
}
