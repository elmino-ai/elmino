import type { Agent } from '@elmino/agent'
import type { AgentEngineOptions, TurnInputPart, TurnRequest } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ThreadLocation } from '@elmino/runtime'
import type { JsonValue, Promisable, UnknownRecord } from '@elmino/shared'
import type { RuntimeStore, RuntimeStoreProvider } from '@elmino/store'
import type { ThreadInputContent } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'

/** Agent 与稳定工作区共同限定执行和存储作用域 */
export interface WorkspaceTarget {
  /** 已注册的 Agent 身份 */
  agentId: string
  /** 宿主工作区身份 */
  workspaceId: string
}

/** 线程读取与执行控制均显式携带归属 */
export interface ThreadTarget extends WorkspaceTarget {
  /** 当前 Agent 与工作区拥有的线程 */
  threadId: string
}

/** 外部创建的 Store 由宿主关闭，Elmino 只管理其上的执行 */
export interface Workspace {
  /** 同一作用域在 Elmino 生命周期中使用同一个 Store */
  store: RuntimeStore
  /** 新线程没有 dir；已有线程按持久化的相对目录恢复 */
  location: (input: { threadId: string, dir?: string }) => Promisable<ThreadLocation>
}

/** 固定本地项目，Store 配置借出的租约由 Elmino 释放 */
export interface LocalWorkspace {
  /** 工作区身份 */
  id: string
  /** 相对根目录以定义 Elmino 时的当前目录为基准 */
  rootDir: string
  /** 外部实例仍由创建方关闭 */
  store: RuntimeStore | RuntimeStoreProvider
}

/** 新任务选择模型，恢复必须按原 Turn 的非敏感快照重建 */
export interface ModelRequest extends WorkspaceTarget {
  /** 本轮取消或 Elmino 关闭时取消模型解析 */
  signal?: AbortSignal
  /** 显式选择、Agent 默认或应用默认的模型键 */
  modelId?: string
  /** 恢复时的精确模型快照，不含凭据 */
  frozenConfig?: UnknownRecord
}

/** 模型工厂通过宿主重新注入凭据，不能把密钥放进 config */
export type ModelFactory = (input: ModelRequest) => Promisable<TurnModel<ModelTurnConfig>>

/** 模型配置 ID 与注册键一致；需恢复历史配置时使用工厂 */
export type ModelRegistration = TurnModel<ModelTurnConfig> | ModelFactory

/** 新 Turn 的输入与执行策略；不接收可执行资源 */
export interface CreateTurnInput extends ThreadTarget, Pick<TurnRequest, 'turnId' | 'approvalMode' | 'subagentMode' | 'signal'> {
  /** 文本或宿主预处理的附件 */
  input: ThreadInputContent[]
  /** 新任务可覆盖默认模型 */
  modelId?: string
}

/** 恢复原中断，不覆盖冻结模型与执行权限 */
export interface ResumeTurnInput extends ThreadTarget {
  /** 原 Turn 身份 */
  turnId: string
  /** 仍有效的中断身份 */
  interruptId: string
  /** 与交互类型对应的恢复决策 */
  response: JsonValue
}

/** 中断准确的活跃 Turn */
export interface InterruptTurnInput extends ThreadTarget {
  /** 目标执行身份 */
  turnId: string
  /** 用户提供的中断原因 */
  reason?: string
}

/** 在执行边界追加输入，不新建或取消 Turn */
export interface SteerTurnInput extends ThreadTarget {
  /** 目标执行身份 */
  turnId: string
  /** 补充要求 */
  text: string
}

/** 稳定前缀分页，持久化投影不依赖传输协议 */
export interface ListThreadsInput extends WorkspaceTarget {
  /** 是否查询已归档记录 */
  archived?: boolean
  /** 本次前缀数量，默认 50 */
  limit?: number
}

/** 本地运行可省略固定工作区和新建的线程、Turn 身份 */
export interface RunInput extends Omit<CreateTurnInput, 'workspaceId' | 'threadId' | 'turnId' | 'input'> {
  /** 动态工作区时必须提供 */
  workspaceId?: string
  /** 省略时新建线程 */
  threadId?: string
  /** 省略时新建 Turn */
  turnId?: string
  /** 最简单的文本输入可直接传字符串 */
  input: string | ThreadInputContent[]
}

/** 传输接入方观察同一份运行事实，取消观察不会中断执行 */
export interface ElminoObserver {
  /** 按 Agent 与工作区发布运行事件 */
  onEvent: (target: WorkspaceTarget, event: RuntimeEvent) => Promisable<void>
  /** Engine 结算之后、存储租约释放之前结束观察 */
  onClose?: () => Promisable<void>
}

/** 与 HTTP 框架无关的应用装配与共享运行资源 */
export interface ElminoOptions {
  /** 工具、Hooks 与 Runtime 归 Agent 定义 */
  agents: Record<string, Agent>
  /** 固定目录可直接配置；动态工作区按作用域首次加载并缓存 */
  workspace: LocalWorkspace | ((target: WorkspaceTarget & { signal?: AbortSignal }) => Promisable<Workspace>)
  /** 注册表用于固定模型目录；函数用于动态模型目录与凭据选择 */
  models: Record<string, ModelRegistration> | ModelFactory
  /** 新任务的应用默认值，恢复不读取当前默认值 */
  defaults?: Pick<TurnRequest, 'approvalMode' | 'subagentMode'> & { model?: string }
  /** 恢复模型与事件出口由 Elmino 统一管理 */
  engine?: Omit<AgentEngineOptions, 'restoreModel' | 'onRuntimeEvent'>
  /** 附件解析属于应用能力；文档输入需要显式提供 */
  prepareInput?: (input: ThreadInputContent[], context: ThreadTarget & {
    /** 实际运行位置 */
    location: ThreadLocation
    /** 可保存文档产物的工作区存储 */
    store: RuntimeStore
  }) => Promisable<TurnInputPart[]>
  /** 不依赖 Server 的运行事件观察 */
  onEvent?: ElminoObserver['onEvent']
  /** 执行、资源清理和观察器错误的报告出口 */
  onError?: (error: unknown) => Promisable<void>
}
