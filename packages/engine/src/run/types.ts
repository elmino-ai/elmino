import type { Agent } from '@elmino/agent'
import type { Message } from '@elmino/llm'
import type { RuntimeStore, ThreadTurnStatus } from '@elmino/store'
import type { TurnInputPart } from '../turn/input'
import type { TurnRequest } from '../turn/types'

/** 在新线程完成一次任务，Engine 的创建与释放由 runAgent 持有 */
export interface RunAgentOptions extends Pick<TurnRequest, 'model' | 'approvalMode' | 'subagentMode' | 'signal' | 'onRuntimeEvent'> {
  /** 已定义提示词、工具与运行环境的 Agent */
  agent: Agent
  /** 宿主创建并关闭的持久化存储 */
  store: RuntimeStore
  /** 本次任务的项目目录，目录须由宿主提前准备 */
  workspace: {
    /** 与存储作用域对应的稳定工作区 ID */
    id: string
    /** 项目根目录，相对路径以调用时的当前目录为基准 */
    rootDir: string
  }
  /** 普通文本可直接传字符串，多模态输入沿用结构化片段 */
  input: string | TurnInputPart[]
}

/** 单次任务完成结算并释放 Engine 后返回的持久化身份与结果 */
export interface RunAgentResult {
  /** 本次新建的线程 ID */
  threadId: string
  /** 本次新建的 Turn ID */
  turnId: string
  /** 实际使用的工作区 ID */
  workspaceId: string
  /** 已持久化的执行状态；审批等待仍保留为 interrupted */
  status: ThreadTurnStatus
  /** 已持久化的执行失败原因；入口和资源关闭错误仍会抛出 */
  errorMessage?: string
  /** 本次执行返回的助手消息，等待交互时可能不存在 */
  message?: Message
}
