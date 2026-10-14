import type { Message, ModelTurnConfig, TextPart, TurnModel } from '@elmino/llm'
import type { Runtime, ThreadLocation } from '@elmino/runtime'
import type { JsonValue, Promisable, UnknownRecord } from '@elmino/shared'
import type { ApprovalMode, RuntimeStore, SubagentMode, SubagentRole, ThreadMessage } from '@elmino/store'
import type {
  RuntimeEvent,
  RuntimeEventType,
  Thread,
  ThreadInteractionInterrupt,
  ThreadInterrupt,
  ThreadSnapshotRecord,
  ThreadToolPart,
} from '@elmino/thread'
import type { DefinedTools, HostServiceBinding } from '@elmino/tool'
import type { ExecutionHooks, ToolResumeResult } from '../../hooks/index'

/** -------------------- 类型 -------------------- */
/** Turn 运行依赖 */
export interface TurnServices {
  /** 线程共用的 Runtime */
  runtime: Runtime
  /** 工作区共用的 RuntimeStore */
  store: RuntimeStore
}

/** Loop 内部结构化运行事件发射器 */
export type TurnRuntimeEventEmitter = (
  type: RuntimeEventType,
  payload: unknown,
  projection?: Pick<
    RuntimeEvent,
    | 'interruptId'
    | 'messageId'
    | 'partId'
    | 'toolCallId'
  >,
) => Promise<void>

/** 单次 Turn 的结构化运行事件回调 */
export type TurnRuntimeEventHandler = (event: RuntimeEvent) => Promisable<void>

/** Engine 已完成事务校验的 Interaction 恢复输入 */
export interface TurnResumeInput {
  /** 当前持久化的权威 Interaction */
  interrupt: ThreadInteractionInterrupt
  /** 归一化后的 JSON 响应 */
  response: JsonValue
  /** 宿主 Interaction 生成的工具结果 */
  toolResult?: ToolResumeResult
  /** 宿主 Interaction 生成的消息片段更新 */
  part?: ThreadToolPart
}

/** Provider 消息与可选持久化事实的配对输入 */
export interface TurnInputMessage {
  /** Provider Context 使用的完整消息 */
  message: Message
  /** 已持久化 Canonical Message 的线程 seq */
  canonicalSeq?: number
  /** 同一消息的完成态 UI transcript 投影 */
  transcript?: ThreadMessage
}

/** 当前 Turn 在 Step 安全边界接收引导消息的能力 */
export interface TurnSteering {
  /** 消费安全边界的引导；完成且无消息时关闭入口，失败或中断只关闭入口 */
  afterStep: (status?: TurnOutcomeStatus) => Promise<TurnInputMessage[]>
}

/** 单次 Turn 会被执行流程消费的输入 */
export interface TurnInput {
  /** 本次新增对话消息 */
  messages?: TurnInputMessage[]
  /** 本次新增隐藏上下文消息，只进入模型上下文，不进入消息快照 */
  hiddenMessages?: Message[]
  /** Engine 已在事务内校验并结算的 Interaction 恢复效果 */
  resume?: TurnResumeInput
}

/** 单次 Turn 的冻结调用上下文 */
export interface TurnContext {
  /** 当前 Turn 冻结的模型 */
  model: TurnModel<ModelTurnConfig>
  /** 当前人机交互访问级别 */
  approvalMode: ApprovalMode
  /** 当前 Turn 冻结的子智能体调度模式 */
  subagentMode: SubagentMode
  /** 当前 Turn 冻结的子智能体角色 */
  subagentRole: SubagentRole
  /** 根 Turn 启动时捕获的可用角色目录 */
  subagentRoles: SubagentRole[]
  /** 子线程 Turn 所属的直接父线程 ID */
  parentThreadId?: string
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
  /** 当前线程稳定存储作用域与实际执行位置 */
  location: ThreadLocation
  /** 外部运行取消信号 */
  signal?: AbortSignal
  /** 当前 Turn 冻结的 Agent ID */
  agentId: string
  /** 最终基础系统提示词 */
  systemPrompt: TextPart[]
  /** 同一线程上一个 Turn 的冻结模型配置 */
  previousModel?: UnknownRecord
  /** 当前 Turn 由 Agent 注入的宿主服务 */
  hostServices: HostServiceBinding[]
  /** 当前 Turn 冻结的工具声明与处理器 */
  tools: DefinedTools
  /** 直接注入的执行扩展 */
  hooks?: ExecutionHooks
  /** 当前 Turn 冻结的 Thread 协议状态能力 */
  thread: Thread
  /** AgentEngine 从同一执行切片冻结的 Turn 启动事实 */
  start: {
    /** 当前 Turn 切为 running 后、扩展启动前捕获的线程恢复快照 */
    threadSnapshot?: ThreadSnapshotRecord
    /** 当前 Turn 是否应触发线程首次启动生命周期 */
    startsThread: boolean
  }
  /** 运行依赖 */
  services: TurnServices
  /** 本次 Turn 的一次性输入 */
  input: TurnInput
  /** 活跃 Turn 的进程内引导入口 */
  steering?: TurnSteering
  /** 结构化运行态事件回调 */
  onRuntimeEvent?: TurnRuntimeEventHandler
}

/** Loop 识别出的 Turn 运行终态 */
export type TurnOutcomeStatus = 'completed' | 'failed' | 'interrupted'

/** 单次 Turn 的终态事实 */
export interface TurnOutcome {
  /** Loop 识别出的运行终态 */
  status: TurnOutcomeStatus
  /** 需要后续恢复的中断载荷 */
  interrupt?: ThreadInterrupt
  /** 不可恢复失败原因 */
  errorMessage?: string
}

/** Turn 完成后交还给 AgentEngine 的结果 */
export interface TurnResult {
  /** 最后一轮 Provider 响应 */
  response?: Message
  /** 单次 Turn 的终态事实 */
  outcome: TurnOutcome
}

/** Loop 运行入口 */
export type LoopInvoker = (context: TurnContext) => Promise<TurnResult>

/** Loop 运行对象 */
export interface Loop {
  /** 显式触发一次 loop 运行，供 server/sdk 使用 */
  invoke: LoopInvoker
}
