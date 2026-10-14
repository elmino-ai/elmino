import type { Message, Tool, ToolCallPart } from '@elmino/llm'
import type { SandboxEnv } from '@elmino/sandbox'
import type { Promisable, UnknownRecord } from '@elmino/shared'
import type { RuntimeToolCallStatus as ToolRuntimeStatus } from '@elmino/store'
import type {
  ThreadExtensionStatePatch,
  ThreadInterrupt,
  ThreadSnapshotRecord,
  ThreadState,
  ThreadToolPart,
} from '@elmino/thread'
import type { DefinedTool, ToolExecutionContext } from '@elmino/tool'
import type { TurnContext, TurnOutcomeStatus } from '../loop/types/index.js'

/** 模型投影中的原始消息归属，处理器必须保留 id 和 turnId */
export interface PromptMessage {
  /** Canonical 消息 ID */
  id: string
  /** 原始消息所属 Turn */
  turnId: string
  /** 发送给模型的消息，允许纯转换或过滤 */
  message: Message
}

/** 一段系统上下文，稳定片段冻结于当前 Turn，动态片段逐请求解析 */
export interface PromptContextSection {
  /** 可选的语义边界标签 */
  tag: string
  /** 上下文正文 */
  content: string
  /** raw 直接插入，tagged 由 Loop 包装语义标签 */
  format?: 'raw' | 'tagged'
}

/** 系统上下文构建的实际能力输入 */
export interface PromptContextInput {
  /** 当前 Turn 的冻结调用上下文 */
  context: TurnContext
  /** 实际提供给模型的工具声明 */
  tools: Tool[]
  /** 工具所使用的运行环境 */
  env: SandboxEnv
  /** 当前执行取消信号 */
  signal?: AbortSignal
}

/** 工具执行前可控制的扩展结果 */
export interface ToolBeforeResult {
  /** 明确阻断或允许调用 */
  decision?: 'allow' | 'block'
  /** 阻断原因 */
  reason?: string
  /** 改写后的工具参数，执行前会再次校验和授权 */
  updatedArgs?: unknown
  /** 随结果回放给模型的额外上下文 */
  additionalContext?: string
}

/** 可接管普通工具投影，或抑制其默认展示 */
export interface ToolProjectionResult {
  /** 是否接管当前调用的默认投影 */
  handled: boolean
  /** 需要持久化或广播的消息片段 */
  part?: ThreadToolPart
}

/** 工具拦截返回结果或可恢复的中断事实 */
export interface ToolInterruptResult {
  /** 挂起当前 Turn 的结构化中断 */
  interrupt?: ThreadInterrupt
  /** 回放给模型的结果，中断时省略表示等待恢复 */
  output?: string
  /** 返回值是否表示执行错误 */
  isError?: boolean
  /** 中断时需要校准的消息片段 */
  part?: ThreadToolPart
  /** 只建立事件关联的已持久化片段 ID */
  partId?: string
}

/** 宿主在恢复事务中结算的工具结果 */
export interface ToolResumeResult {
  /** Provider 原生工具调用 ID */
  callId: string
  /** 回放结果正文 */
  output: string
  /** 是否为错误结果 */
  isError?: boolean
}

/** 当前 Turn 的临时通知，不另存一份运行状态 */
export interface ExecutionNotification {
  /** 通知标题 */
  title: string
  /** 可选详情 */
  detail?: string
  /** 自定义数据 */
  payload?: UnknownRecord
}

/** 执行阶段明确拥有的生命周期载荷 */
export interface ExecutionEventMap {
  /** 当前线程首次启动 */
  'thread.start': Record<string, never>
  /** 当前 Turn 启动 */
  'turn.start': Record<string, never>
  /** 完成全部引导后的 Turn 终态 */
  'turn.completed': { messages: Message[], response?: Message }
  /** 当前 Turn 新提交的用户消息 */
  'user.prompt.submit': { messages: Message[] }
  /** 已采样且即将进入工具批次的调用 */
  'tool.batch.started': { parts: ToolCallPart[] }
}

/** 当前 Turn 启动后可供扩展使用的作用域，不拥有 Runtime 关闭权 */
export interface ExecutionScope {
  /** 当前冻结执行上下文 */
  context: TurnContext
  /** 启动前冻结的恢复快照 */
  snapshot?: ThreadSnapshotRecord
  /** 当前新增的 Provider 消息 */
  incomingMessages: Message[]
  /** 当前输入写入前的历史上下文 */
  previousMessages: Message[]
  /** 压缩当前较早历史并返回模型可用的确认文本 */
  compact: () => Promise<string>
  /** 保存当前恢复快照并广播 */
  saveSnapshot: () => Promise<void>
  /** 更新线程的自动标题并广播 */
  updateTitle: (title: string) => Promise<ThreadState>
  /** 更新一个扩展命名空间的持久恢复状态 */
  updateState: (key: string, state?: UnknownRecord) => Promise<void>
  /** 发布仅属于当前 Turn 的临时通知 */
  notify: (notification: ExecutionNotification) => Promise<void>
}

/** 直接注入的执行扩展，不持有扩展注册、解析或宿主系统 */
export interface ExecutionHooks {
  /** 初始化线程元信息，不生成第二份线程状态 */
  initialThread?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前输入写入前的模型历史 */
    previousMessages: Message[]
    /** 冻结的恢复快照 */
    snapshot?: ThreadSnapshotRecord
  }) => Promisable<{ autoTitle?: string } | undefined>
  /** Turn 已启动后获取资源，返回仅属于当前 Turn 的释放函数 */
  onStarted?: (scope: ExecutionScope) => Promisable<void | (() => Promisable<void>)>
  /** 终态快照前收束扩展任务，取消后也必须可以执行 */
  beforeSnapshot?: (input: { context: TurnContext, status: TurnOutcomeStatus }) => Promisable<void>
  /** 收集需要随当前线程恢复的命名空间增量 */
  collectState?: (context: TurnContext) => Promisable<ThreadExtensionStatePatch>
  /** 按执行生命周期处理固定载荷 */
  onLifecycle?: <TEvent extends keyof ExecutionEventMap>(
    event: TEvent,
    input: { context: TurnContext, payload: ExecutionEventMap[TEvent], signal?: AbortSignal },
  ) => Promisable<void>
  /** 当前 Turn 首次模型请求解析一次，并冻结到本执行切片 */
  promptStable?: (input: PromptContextInput) => Promisable<PromptContextSection[]>
  /** 每次模型请求前重新解析的动态上下文 */
  promptDynamic?: (input: PromptContextInput) => Promisable<PromptContextSection[]>
  /** 提醒消息追加为 Canonical 事实，不进入 transcript */
  promptMessages?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前模型历史 */
    messages: Message[]
    /** 当前取消信号 */
    signal?: AbortSignal
  }) => Promisable<Message[]>
  /** 保留原始归属的纯投影，供采样、计数和摘要共用 */
  processMessages?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 携带 Canonical 归属的原始消息 */
    messages: readonly PromptMessage[]
    /** 当前取消信号 */
    signal?: AbortSignal
  }) => Promisable<readonly PromptMessage[] | undefined>
  /** 工具执行前改写或阻断，不扩大授权范围 */
  beforeTool?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前调用 */
    part: ToolCallPart
    /** 取消信号 */
    signal?: AbortSignal
  }) => Promisable<ToolBeforeResult | undefined>
  /** 工具成功执行后处理已生成的结果 */
  afterTool?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前调用 */
    part: ToolCallPart
    /** 最终执行状态 */
    status: ToolRuntimeStatus
    /** 原始文本输出 */
    output: string
    /** 取消信号 */
    signal?: AbortSignal
  }) => Promisable<void>
  /** 审批前与参数改写后均执行的同步授权策略 */
  authorizeTool?: (
    tool: DefinedTool | undefined,
    args: unknown,
    execution: ToolExecutionContext,
    context: TurnContext,
  ) => string | undefined
  /** 普通审批前接管单个调用，返回结果或中断 */
  interceptTool?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前尚未结算的工具调用 */
    part: ToolCallPart
    /** 取消信号 */
    signal?: AbortSignal
  }) => Promisable<ToolInterruptResult | undefined>
  /** 流式草稿与完成快照共用的工具消息投影 */
  projectTool?: (input: {
    /** 当前执行上下文 */
    context: TurnContext
    /** 当前调用 */
    part: ToolCallPart
    /** 投影阶段 */
    phase: 'streaming' | 'completed'
    /** 当前取消信号 */
    signal?: AbortSignal
  }) => Promisable<ToolProjectionResult>
}
