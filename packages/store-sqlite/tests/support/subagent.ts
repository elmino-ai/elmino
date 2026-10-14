import type { SubagentRole } from '@elmino/store'

/** -------------------- 常量 -------------------- */
/** 测试 Turn 使用的稳定默认子智能体角色 */
export const testSubagentRole: SubagentRole = {
  id: 'default',
  name: '通用',
  description: '测试默认子智能体角色',
  icon: 'bot',
  instructions: '完成当前测试任务。',
}

/** 根 Turn 测试使用的冻结角色目录 */
export const testSubagentRoles = [testSubagentRole]
