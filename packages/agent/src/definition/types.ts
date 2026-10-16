import type { Message } from '@elmino/llm'
import type { ExecutionHooks, Loop, ToolResumeResult } from '@elmino/loop'
import type { RuntimeDefinition } from '@elmino/runtime'
import type { JsonValue, Promisable, UnknownRecord } from '@elmino/shared'
import type { Thread, ThreadExtensionState, ThreadInteractionInterrupt, ThreadToolPart } from '@elmino/thread'
import type { DefinedTools } from '@elmino/tool'
/** 单个扩展命名空间的事务化状态动作 */
export type StateResolution = { type: 'keep' } | { type: 'replace', value: UnknownRecord } | { type: 'remove' }

/** 恢复交互时与 Turn 转换一同持久化的效果 */
export interface InteractionResolution {
  /** 继续执行或取消当前 Turn */
  action: 'resume' | 'cancel'
  /** 归一化后交给 Loop 的响应 */
  response: JsonValue
  /** 需要追加到对话的用户输入 */
  input?: string
  /** 只进入模型上下文的消息 */
  hiddenMessages?: Message[]
  /** 交互接管的工具结果 */
  toolResult?: ToolResumeResult
  /** 交互结果对应的消息片段 */
  part?: ThreadToolPart
  /** 同事务更新的扩展命名空间 */
  state?: Record<string, StateResolution>
}

/** Agent 持有的执行与事务扩展，均由宿主直接提供 */
export interface AgentHooks extends ExecutionHooks {
  /** 在恢复事务内纯解析自定义交互，不执行外部副作用 */
  resolveInteraction?: (input: {
    /** 权威的持久化交互 */
    interrupt: ThreadInteractionInterrupt
    /** 用户提交的响应 */
    response: JsonValue
    /** 线程当前的扩展状态 */
    state: ThreadExtensionState
  }) => Promisable<InteractionResolution | undefined>
  /** 在稳定终态事务内纯结算扩展状态，等待交互时不调用 */
  settleState?: (input: {
    /** 当前终态 */
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    /** 线程当前扩展状态 */
    state: ThreadExtensionState
  }) => Promisable<Record<string, StateResolution> | undefined>
}

/** 单次 Turn 持久化的 Agent 内容快照 */
export interface AgentSnapshot {
  /** 稳定的 Agent ID */
  id: string
  /** 启动时冻结的基础系统提示词 */
  systemPrompt: string
}

/** 具有工具、执行器和运行环境的 Agent 定义 */
export interface Agent extends AgentSnapshot {
  /** 在 Elmino 模型注册表中选择默认模型，本轮执行可覆盖 */
  model?: string
  /** 展示名称 */
  name: string
  /** 能力说明 */
  description: string
  /** 可直接执行的工具集合 */
  tools: DefinedTools
  /** 宿主提供的执行扩展 */
  hooks?: AgentHooks
  /** 单轮执行器 */
  loop: Loop
  /** 持久线程的协议投影 */
  thread: Thread
  /** 线程运行环境创建边界 */
  runtime: RuntimeDefinition
}

/** 定义 Agent 时可省略默认执行器、线程投影与展示信息 */
export type AgentDefinition = Omit<Agent, 'name' | 'description' | 'loop' | 'thread' | 'tools'>
  & Partial<Pick<Agent, 'name' | 'description' | 'loop' | 'thread' | 'tools'>>
