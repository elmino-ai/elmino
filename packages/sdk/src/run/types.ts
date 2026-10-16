import type { ApiClient, ApiTurnCreateInput, ApiTurnResumeInput } from '@elmino/api'
import type { ThreadInteractionInterrupt, ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { ToolApprovalInterruptPayload } from '@elmino/tool'

/** 当前运行中的工具终态片段，包含工具名、参数、结果与执行状态 */
export type ClientRunToolResult = Extract<ThreadState['messages'][number]['parts'][number], { type: 'tool' }>

/** 远程单次执行；输入身份与策略复用实际 API 契约 */
export interface ClientRunOptions extends Omit<ApiTurnCreateInput, 'threadId' | 'turnId' | 'input'> {
  /** 省略时创建新线程；继续会话时传回上次结果中的身份 */
  threadId?: string
  /** 省略时生成新运行身份；自行指定便于在本地取消等待后查询或控制远端 */
  turnId?: string
  /** 普通文本可直接传字符串，附件使用 API 输入数组 */
  input: string | ApiTurnCreateInput['input']
  /** 只取消客户端等待与订阅，不自动停止已接纳的远端任务；缺省不限制等待时长 */
  signal?: AbortSignal
  /** 新增助手正文；断线补齐时可能一次收到较长尾部，按顺序等待回调完成 */
  onText?: (text: string) => void | Promise<void>
  /** 模型实际提供的可见思考增量，不生成替代内容 */
  onReasoning?: (text: string) => void | Promise<void>
  /** 每个可见工具片段的最终结果只通知一次，失败与跳过也包含在内 */
  onToolResult?: (part: ClientRunToolResult) => void | Promise<void>
  /** 本线程、本 Turn 的事实；慢回调积压时改用快照补齐输出，不补造原始事件；逐事件处理请用 client.subscribe */
  onEvent?: (event: RuntimeEvent) => void | Promise<void>
}

/** 已捕获身份的待处理交互；不可用当前另一轮的交互替换它 */
export interface ClientInteraction extends Omit<ApiTurnResumeInput, 'response'> {
  /** 完整交互说明与宿主扩展数据 */
  interrupt: ThreadInteractionInterrupt
  /** 内置工具审批的类型化请求；普通自定义交互没有该字段 */
  approval?: ToolApprovalInterruptPayload
}

/** 绑定会话后的执行配置，Agent、工作区和线程身份已由会话持有 */
export type ClientThreadRunOptions = Omit<ClientRunOptions, 'agentId' | 'workspaceId' | 'threadId' | 'input'>

/** 恢复或重新观察不允许切换原模型与权限 */
export type ClientObserveOptions = Pick<ClientRunOptions, 'signal' | 'onText' | 'onReasoning' | 'onToolResult' | 'onEvent'>

/** 已从服务端快照确认的执行结果 */
export interface ClientRunResult {
  /** 实际执行的 Agent */
  agentId: string
  /** 任务所在工作区 */
  workspaceId: string
  /** 后续会话与控制操作沿用的线程身份 */
  threadId: string
  /** 本次运行身份 */
  turnId: string
  /** 当前执行片段的终态；运行失败和审批中断也正常返回 */
  status: Extract<ThreadState['turns'][number]['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted'>
  /** 失败运行的持久化诊断，刷新和重启后仍可读取 */
  errorMessage?: string
  /** 本 Turn 最后一条助手消息，未生成消息时缺省 */
  message?: ThreadState['messages'][number]
  /** 本轮仍待处理的交互，可直接交给会话审批或恢复；不会取其他 Turn 的交互 */
  interaction?: ClientInteraction
  /** 权威线程快照，包含历史、工具结果与待处理交互 */
  thread: ThreadState
}

/** 一次执行片段的固定身份与控制权，不暴露内部提交工厂 */
export interface ClientRun {
  /** 实际执行的 Agent */
  readonly agentId: string
  /** 服务端工作区 */
  readonly workspaceId: string
  /** 固定会话身份 */
  readonly threadId: string
  /** 创建、恢复或观察的准确 Turn */
  readonly turnId: string
  /** 服务端已接纳提交或已找到被观察运行 */
  readonly accepted: Promise<void>
  /** 当前执行片段的终态与权威快照 */
  readonly completed: Promise<ClientRunResult>
  /** 停止远端准确 Turn，尚在提交时先等待接纳 */
  interrupt: (reason?: string) => Promise<ThreadState>
  /** 在执行边界追加要求，不另建 Turn */
  steer: (text: string) => ReturnType<ApiClient['turn']['steer']>
  /** 只结束当前客户端观察，远端执行继续 */
  detach: (reason?: unknown) => void
}
