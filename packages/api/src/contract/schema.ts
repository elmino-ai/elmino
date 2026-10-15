import { THREAD_ID_PATTERN } from '@elmino/protocol'
import { z } from 'zod'

/** 宿主定义配置键，保留原始身份而不修改空白或添加产品前缀 */
export const HostIdSchema = z.string().min(1).refine(value => value.trim().length > 0)
export { JsonValueSchema } from '@elmino/protocol'
/** 无业务参数的 procedure，RPC 可以省略输入 */
export const EmptyInputSchema = z.strictObject({}).default({})
/** 全部工作区操作都必须明确 Agent 与稳定存储作用域 */
export const AgentWorkspaceTargetSchema = z.strictObject({
  agentId: HostIdSchema,
  workspaceId: HostIdSchema,
})
/** 线程操作不能仅凭 threadId 隐式选择 Agent 或工作区 */
export const ThreadTargetSchema = AgentWorkspaceTargetSchema.extend({
  threadId: z.string().regex(THREAD_ID_PATTERN),
})

export type AgentWorkspaceTarget = z.infer<typeof AgentWorkspaceTargetSchema>
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>
