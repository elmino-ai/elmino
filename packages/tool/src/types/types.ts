import type { Tool, ToolResultContent } from '@elmino/llm'
import type { Sandbox, SandboxReviewInput } from '@elmino/sandbox'
import type { Promisable } from '@elmino/shared'
import type * as z from 'zod'
import type { HostServices } from '../services/services.js'

/** -------------------- 类型 -------------------- */
/** 同时保留 Runtime 文本投影与 Provider 富内容的工具结果 */
export interface StructuredToolResult {
  /** RuntimeStore、事件与 UI 持久化的文本投影 */
  output: string
  /** Provider 工具结果接收的文本或富内容 */
  content: ToolResultContent
  /** 是否将返回值标记为工具错误 */
  isError?: boolean
}

/** 工具执行的归一化值 */
export type ToolResultValue = string | StructuredToolResult

/** 工具执行结果 */
export type ToolResult = Promisable<ToolResultValue>

/** 工具审批策略 */
export type ToolApprovalRequirement = 'auto' | 'never'

/** 工具调用供受限策略匹配的作用范围 */
export type ToolScope = 'inspect' | 'develop' | 'modify'

/** 动态工具互斥返回调研/开发范围，或带原因的修改范围 */
export type ToolScopeReview
  = | {
    /** 本次调用属于受限模式可直接允许的调研或开发范围 */
    scope: Exclude<ToolScope, 'modify'>
    /** 调研和开发范围不携带拒绝原因 */
    reason?: never
  }
  | {
    /** 本次调用属于修改范围 */
    scope: 'modify'
    /** 修改范围被当前限制拒绝时返回给模型的原因 */
    reason: string
  }

/** 按本次参数解析工具允许进入的受限作用范围 */
export type ToolScopeResolver<TArgs = unknown> = (
  args: TArgs,
  context: ToolExecutionContext,
) => ToolScopeReview

/** 子智能体工具对外任务状态 */
export type SubagentStatus
  = | 'queued'
    | 'running'
    | 'waiting'
    | 'interrupted'
    | 'completed'
    | 'failed'
    | 'cancelled'

/** 工具执行函数类型 */
export type ToolRunner<
  TArgs,
  TResult extends ToolResult = ToolResult,
> = (
  args: TArgs,
  context: ToolExecutionContext,
) => TResult

/** 子智能体提交请求 */
export interface SpawnSubagentRequest {
  /** 创建子线程的能力所有者 ID */
  ownerId: string
  /** 子任务角色 ID */
  role: string
  /** 子任务名称 */
  name: string
  /** 子任务完整说明 */
  description: string
  /** 父工具调用的 RuntimeStore ID */
  parentToolCallId: string
}

/** 子智能体查询结果 */
export interface SubagentResult {
  /** 子线程 ID */
  threadId: string
  /** 子线程 Turn ID */
  turnId: string
  /** 子任务名称 */
  name: string
  /** 当前任务状态 */
  status: SubagentStatus
  /** 最终文本结果 */
  result?: string
  /** 失败原因 */
  error?: string
}

/** 等待目标子任务状态变化的参数 */
export interface SubagentWaitInput {
  /** 目标子线程 ID 列表 */
  threadIds: string[]
  /** 最大等待时间 */
  timeoutMs: number
}

/** 等待目标子任务状态变化的结果 */
export interface SubagentWaitResult {
  /** 是否因等待超时返回 */
  timedOut?: boolean
  /** 当前目标子任务快照 */
  subagents: SubagentResult[]
}

/** AgentEngine 注入的子智能体控制面 */
export interface SubagentController {
  /** 创建并异步提交一个子任务 */
  spawn: (input: SpawnSubagentRequest) => Promise<SubagentResult>
  /** 等待任一目标子任务发生可观察状态变化 */
  wait: (input: SubagentWaitInput) => Promise<SubagentWaitResult>
  /** 列出当前父线程的直接子任务 */
  list: () => Promise<SubagentResult[]>
  /** 中断当前父线程的直接子任务 */
  interrupt: (threadId: string) => Promise<SubagentResult>
}

/** 单个工具定义的通用参数 */
export interface ToolDefinition<
  TSchema extends z.ZodType = z.ZodType,
  TResult extends ToolResult = ToolResult,
> {
  /** 工具描述，展示给模型 */
  description: string
  /** 工具参数 Schema */
  schema: TSchema
  /** 是否在面向用户的消息投影中隐藏 */
  hidden?: boolean
  /** 普通模式审批策略，默认 never，需要审批时显式声明 auto */
  approval?: ToolApprovalRequirement
  /** 是否允许与同批其他并行工具同时执行 */
  parallel?: boolean
  /** 将工具参数投影为沙箱审批输入 */
  review?: (args: z.infer<TSchema>) => SandboxReviewInput | undefined
  /** 允许进入的静态受限作用范围，或按本次参数动态解析；不声明时仅在普通模式开放 */
  scope?: ToolScope | ToolScopeResolver<z.infer<TSchema>>
  /** 工具执行函数 */
  execute: ToolRunner<
    z.infer<TSchema>,
    TResult
  >
}

/** 工具执行时的运行时上下文 */
export interface ToolExecutionContext {
  /** 当前工具调用的 RuntimeStore ID */
  toolCallId?: string
  /** 当前执行环境，文件和命令都从这里进入 */
  sandbox: Sandbox
  /** 当前 Turn 注入的宿主能力 */
  services?: HostServices
  /** 向宿主发送当前工具的增量输出 */
  onToolProgress?: (outputDelta: string) => Promisable<void>
  /** 当前运行取消信号 */
  signal?: AbortSignal
}

/** 单个已定义工具 */
export interface DefinedTool {
  /** 跨 Provider 工具声明 */
  declaration: Tool
  /** 是否在面向用户的消息投影中隐藏 */
  hidden?: boolean
  /** 工具审批策略 */
  approval: ToolApprovalRequirement
  /** 是否允许与同批其他并行工具同时执行 */
  parallel: boolean
  /** 将未校验的 provider 参数投影为沙箱审批输入 */
  review?: (args: unknown) => SandboxReviewInput | undefined
  /** 允许进入的静态受限作用范围，或按参数解析本次调用；不声明时仅在普通模式开放 */
  scope?: ToolScope | ToolScopeResolver
  /** 本地工具执行函数 */
  execute: ToolRunner<unknown>
}

/** 批量定义后的工具集合 */
export interface DefinedTools<TTools extends Record<string, DefinedTool> = Record<string, DefinedTool>> {
  /** 跨 Provider 工具声明 */
  declarations: Tool[]
  /** 本地工具执行器映射 */
  handlers: TTools & Record<string, DefinedTool>
}
