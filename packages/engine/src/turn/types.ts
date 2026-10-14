import type { AgentHooks, AgentSnapshot } from '@elmino/agent'
import type { Message, ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { TurnInputMessage, TurnRuntimeEventHandler, TurnServices } from '@elmino/loop'
import type { ThreadLocation } from '@elmino/runtime'
import type { SubagentMode, SubagentRole, ThreadTurnStatus } from '@elmino/store'
import type { ResumeTurnInput } from '@elmino/thread'
import type { ApprovalMode, DefinedTools } from '@elmino/tool'
import type { TurnControl } from '../engine/control.js'
import type { TurnInputPart } from './input.js'
/** -------------------- 类型 -------------------- */
/** HTTP、子智能体和未来定时调度器统一提交的 Turn 请求 */
export interface TurnRequest<Input = TurnInputPart[] | (() => Promise<TurnInputPart[]>)> {
  /** 当前线程固定所属的 Agent */
  agentId: string
  /** 当前 Turn 冻结的模型 */
  model: TurnModel<ModelTurnConfig>
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
  /** 当前线程稳定存储作用域与实际执行位置 */
  location: ThreadLocation
  /** 本轮结构化用户输入 */
  input?: Input
  /** 当前人机交互访问级别 */
  approvalMode?: ApprovalMode
  /** 当前子智能体调度模式 */
  subagentMode?: SubagentMode
  /** 本次新增隐藏上下文消息，只进入模型上下文 */
  hiddenMessages?: Message[]
  /** 恢复上一次 Interaction 的统一请求 */
  resume?: ResumeTurnInput
  /** 外部运行取消信号 */
  signal?: AbortSignal
  /** 结构化运行态事件回调 */
  onRuntimeEvent?: TurnRuntimeEventHandler
}
/** Engine 已在入口预留内解析完成输入的 Turn 请求 */
export type ResolvedTurnRequest = TurnRequest<TurnInputPart[]>
/** Engine 准备阶段允许继续执行的持久 Turn 状态 */
export type PreparedTurnStatus = Extract<
  ThreadTurnStatus,
  'queued' | 'running' | 'interrupted'
>
/** AgentEngine 异步提交后返回的 Turn 句柄 */
export interface TurnHandle {
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
  /** Turn 当前调度状态 */
  status: 'queued' | 'running'
}
/** 前台 Turn 的接纳确认和完整执行结果 */
export interface TurnExecution {
  /** 输入和启动状态已持久化；不等待 Provider 或工具执行 */
  accepted: Promise<void>
  /** 完成全部执行和结算后的结果 */
  completed: Promise<Message | undefined>
}
/** Engine 内部已经完成入口归一化的 Turn 参数 */
export interface PreparedTurn {
  /** 当前 Turn 冻结的模型 */
  model: TurnModel<ModelTurnConfig>
  /** 当前线程 ID */
  threadId: string
  /** 当前 Turn ID */
  turnId: string
  /** 当前线程稳定存储作用域与实际执行位置 */
  location: ThreadLocation
  /** 外部运行取消信号 */
  signal?: AbortSignal
  /** 结构化运行态事件回调 */
  onRuntimeEvent?: TurnRuntimeEventHandler
  /** Engine 已归一化的本轮模型上下文消息 */
  messages: TurnInputMessage[]
  /** Engine 已归一化的本轮隐藏上下文消息 */
  hiddenMessages: Message[]
  /** 当前 Turn 冻结的工具定义 */
  tools: DefinedTools
  /** 当前 Turn 冻结的执行扩展 */
  hooks?: AgentHooks
  /** 恢复上一次 Interaction 的统一请求 */
  resume?: ResumeTurnInput
  /** 当前 Turn 作用域内复用的 Runtime 与项目 Store */
  services: TurnServices
  /** 当前 Turn 冻结的子智能体角色 */
  subagentRole: SubagentRole
  /** 根 Turn 启动时捕获的可用角色目录 */
  subagentRoles: SubagentRole[]
  /** 子线程 Turn 所属的直接父线程 ID */
  parentThreadId?: string
  /** 当前 Turn 冻结的 Agent 定义 */
  agentSnapshot: AgentSnapshot
  /** 当前人机交互访问级别 */
  approvalMode: ApprovalMode
  /** 当前 Turn 冻结的子智能体调度模式 */
  subagentMode: SubagentMode
  /** 持久化事实里的当前 Turn 状态 */
  turnStatus: PreparedTurnStatus
  /** 根 Turn 的进程内控制权 */
  control?: TurnControl
}
