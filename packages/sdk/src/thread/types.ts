import type { AgentWorkspaceTarget } from '@elmino/api'

/** 一次绑定 Agent、工作区和会话；省略线程身份只在客户端预分配，首次运行才持久化 */
export interface ClientThreadOptions extends AgentWorkspaceTarget {
  /** 恢复既有会话时提供，省略时生成新身份 */
  threadId?: string
}
