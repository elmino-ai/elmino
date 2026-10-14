/** -------------------- 类型 -------------------- */
/** 子智能体调度模式，显式调用或允许主动派生 */
export type SubagentMode = 'explicitOnly' | 'proactive'

/** 子智能体角色图标语义 */
export type SubagentRoleIcon = 'bot' | 'compass' | 'tool'

/** Turn 启动时冻结的完整子智能体角色 */
export interface SubagentRole {
  /** 宿主提供的稳定角色 ID */
  id: string
  /** 角色展示名称 */
  name: string
  /** 供根 Turn 选择角色的简介 */
  description: string
  /** 角色图标语义 */
  icon: SubagentRoleIcon
  /** 注入子智能体 Turn 的角色指令 */
  instructions: string
}
