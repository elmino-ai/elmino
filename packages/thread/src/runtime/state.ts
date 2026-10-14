import type { ApprovalMode, ThreadStatus, ThreadTokenUsage } from '@elmino/store'
import type { ThreadContextBudget } from './budget.js'
import type { ThreadInterrupt } from './interrupt.js'

/** -------------------- 类型 -------------------- */
/** 从持久化执行事实投影的线程运行状态 */
export interface ThreadRuntimeState {
  /** 当前状态 */
  status: ThreadStatus
  /** 尚未固定终态的当前 Turn */
  turnId?: string
  /** 当前宿主模型配置 ID */
  modelId?: string
  /** 当前 Agent ID */
  agentId: string
  /** 当前人机交互访问级别 */
  approvalMode: ApprovalMode
  /** 当前线程用量 */
  usage: ThreadTokenUsage
  /** 当前线程及派生子线程的累计用量 */
  taskUsage: ThreadTokenUsage
  /** 当前上下文预算 */
  contextBudget?: ThreadContextBudget
  /** 当前可恢复中断 */
  interrupt?: ThreadInterrupt
}
