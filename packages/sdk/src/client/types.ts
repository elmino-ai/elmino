import type { CreateRequestOptions } from '@elmino/request'
import type { RuntimeEvent } from '@elmino/thread/events'

/** 事件订阅连续失败时的有界指数退避配置 */
export interface ClientRetryOptions {
  /** 第一次重连前的等待时间，默认 500 毫秒 */
  initialDelayMs?: number
  /** 连续失败时的最大等待时间，默认 10000 毫秒 */
  maxDelayMs?: number
}

/** 纯客户端 API 和订阅传输配置 */
export interface ClientOptions {
  /** 服务基础地址，保留宿主挂载前缀 */
  baseUrl: string
  /** 默认 Bearer 凭据，显式 Header 可以覆盖 */
  apiKey?: string
  /** 每次请求使用的静态或异步 Header */
  headers?: CreateRequestOptions['headers']
  /** 浏览器或 Node.js 的可注入 Fetch */
  fetch?: CreateRequestOptions['fetch']
  /** 运行事件连接的重试策略 */
  retry?: ClientRetryOptions
}

/** 只有事实投影或重建快照成功后才确认相应事件游标 */
export interface RuntimeEventSubscribeHandlers {
  /** 顺序处理一个完整运行事件，失败时从上个已确认游标重试 */
  onEvent: (event: RuntimeEvent) => void | Promise<void>
  /** 回放窗口失效后重建权威状态，完成前不确认重置游标 */
  onReset?: () => void | Promise<void>
  /** 每段连续断线只通知一次，观察者失败不影响重连 */
  onError?: (error: unknown) => void | Promise<void>
}
