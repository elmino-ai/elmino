import type { Elmino } from '@elmino/core'
import type { Promisable } from '@elmino/shared'
import type { Hono } from 'hono'

/** 所有网络操作的授权上下文，批处理中的每个调用分别授权 */
export interface ServerAuthorization {
  /** 当前 HTTP 请求 */
  request: Request
  /** 被调用的 procedure 路径 */
  path: readonly string[]
  /** 经过 Schema 校验的输入，宿主可据此限制资源范围 */
  input: unknown
}

/** 独立 Node 服务的启动配置，首次 start 调用确定监听参数 */
export interface ServerStartOptions {
  /** 显式配置优先于 ELMINO_PORT，缺省为 3000；传 0 分配可用端口，首次启动后固定 */
  port?: number
  /** 显式配置优先于 ELMINO_HOST，缺省为 127.0.0.1，仅允许本机连接 */
  hostname?: string
  /** 默认处理 SIGINT / SIGTERM 并关闭 Server；宿主统一关闭 Elmino 时设为 false */
  shutdownSignals?: boolean
}

/** 可嵌入任意 Fetch HTTP 宿主的 Agent 服务 */
export interface ServerOptions {
  /** 由宿主创建并关闭的应用实例，可同时交给多个接入方 */
  elmino: Elmino
  /** 固定 Bearer 凭据；缺省读取 ELMINO_SERVER_KEY，null 禁用环境凭据，空字符串无效 */
  apiKey?: string | null
  /** 可检查身份与输入资源范围；配置 apiKey 时须先通过凭据校验 */
  authorize?: (context: ServerAuthorization) => Promisable<boolean>
  /** 每个 Agent / 工作区独立回放窗口的字节上限 */
  eventBufferBytes?: number
  /** HTTP 请求与监听关闭的错误报告，执行错误由 Elmino 报告 */
  onError?: (error: unknown) => Promisable<void>
  /** 允许的完整浏览器 Origin；缺省读取逗号分隔的 ELMINO_CORS_ORIGINS，[] 禁用环境配置 */
  corsOrigins?: readonly string[]
  /** 同步注册 Hono 中间件与自定义路由，先于内置 API；自定义接口的鉴权由宿主负责 */
  http?: (app: Hono) => void
  /** 默认公开静态 API 文档与 Schema；false 关闭文档，业务接口始终遵循 authorize */
  apiReference?: false | {
    /** 文档和 OpenAPI 标题，默认 Elmino API */
    title?: string
    /** OpenAPI 标注的宿主 API 版本，默认 0.0.0 */
    version?: string
  }
}
