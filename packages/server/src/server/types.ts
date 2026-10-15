import type { Agent } from '@elmino/agent'
import type { AgentWorkspaceTarget } from '@elmino/api'
import type { AgentEngineOptions, TurnInputPart } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ThreadLocation } from '@elmino/runtime'
import type { Promisable, UnknownRecord } from '@elmino/shared'
import type { RuntimeStore, RuntimeStoreProvider } from '@elmino/store'
import type { ThreadInputContent } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'

/** 宿主拥有 Store；Server 仅拥有在其上运行的 Engine 与订阅 */
export interface ServerWorkspace {
  /** 同一作用域在 Server 生命周期中使用同一个 Store 实例 */
  store: RuntimeStore
  /** 从持久化目录恢复位置，新线程没有 dir，由宿主决定初始位置 */
  location: (input: { threadId: string, dir?: string }) => Promisable<ThreadLocation>
}

/** 固定本地项目工作区，线程目录由 Server 根据持久记录计算 */
export interface LocalServerWorkspace {
  /** 客户端使用的工作区身份 */
  id: string
  /** 项目根目录，相对路径以定义 Server 时的当前目录为基准 */
  rootDir: string
  /** 实例由宿主关闭；配置在首次访问时借用，Server 关闭时释放 */
  store: RuntimeStore | RuntimeStoreProvider
}

/** 解析新任务或按已持久化的非敏感配置恢复模型 */
export interface ServerModelRequest extends AgentWorkspaceTarget {
  /** Server 关闭时取消尚未完成的模型解析 */
  signal?: AbortSignal
  /** 新任务选择的宿主模型键 */
  modelId?: string
  /** 恢复时必须精确遵循的模型快照，不含凭据 */
  frozenConfig?: UnknownRecord
}

/** 所有网络操作的授权上下文，批处理中的每个调用分别授权 */
export interface ServerAuthorization {
  /** 当前 HTTP 请求 */
  request: Request
  /** 被调用的 procedure 路径 */
  path: readonly string[]
  /** 经过 Schema 校验的输入，宿主可据此限制资源范围 */
  input: unknown
}

/** 可嵌入任意 Fetch HTTP 宿主的 Agent 服务 */
export interface ServerOptions {
  /** 已装配好工具、Hooks 与 Runtime 的 Agent 定义 */
  agents: Record<string, Agent>
  /** 固定本地工作区可直接传配置；动态资源按 Agent / 工作区首次加载并缓存 */
  workspace: LocalServerWorkspace | ((target: AgentWorkspaceTarget & {
    /** Server 关闭时取消尚未完成的工作区打开 */
    signal?: AbortSignal
  }) => Promisable<ServerWorkspace>)
  /** 为新 Turn 动态选择模型，恢复时使用 frozenConfig；凭据由宿主提供 */
  model: (input: ServerModelRequest) => Promisable<TurnModel<ModelTurnConfig>>
  /** 可选 Engine 扩展；模型恢复与事件出口由 Server 统一装配 */
  engine?: Omit<AgentEngineOptions, 'restoreModel' | 'onRuntimeEvent'>
  /** 可选的固定 Bearer 凭据，与 SDK 的 apiKey 对应 */
  apiKey?: string
  /** 可检查身份与输入资源范围；配置 apiKey 时须先通过凭据校验 */
  authorize?: (context: ServerAuthorization) => Promisable<boolean>
  /** 附件预处理；省略时支持文本、引用和原始图片，文档需要宿主解析 */
  prepareInput?: (input: ThreadInputContent[], context: AgentWorkspaceTarget & {
    /** 线程 ID */
    threadId: string
    /** 实际运行位置 */
    location: ThreadLocation
    /** 可保存文档解析产物的存储 */
    store: RuntimeStore
  }) => Promisable<TurnInputPart[]>
  /** 每个 Agent / 工作区独立回放窗口的字节上限 */
  eventBufferBytes?: number
  /** 可选的事件观察出口，不拥有执行生命周期 */
  onEvent?: (target: AgentWorkspaceTarget, event: RuntimeEvent) => Promisable<void>
  /** 接纳后执行错误及观察器错误的报告出口 */
  onError?: (error: unknown) => Promisable<void>
  /** 允许跨域调用的浏览器 Origin，默认不开启跨域访问 */
  corsOrigins?: readonly string[]
  /** 默认公开静态 API 文档与 Schema；false 关闭文档，业务接口始终遵循 authorize */
  apiReference?: false | {
    /** 文档和 OpenAPI 标题，默认 Elmino API */
    title?: string
    /** OpenAPI 标注的宿主 API 版本，默认 0.0.0 */
    version?: string
  }
}
