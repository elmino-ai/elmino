import { ThreadIdSchema } from '@elmino/protocol'
import { NonBlankStringSchema } from '@elmino/schema'
import { z } from 'zod'

/** 宿主定义配置键，保留原始身份而不修改空白或添加产品前缀 */
export const HostIdSchema = NonBlankStringSchema
export { JsonValueSchema } from '@elmino/protocol'
/** 无业务参数的 procedure，RPC 可以省略输入 */
export const EmptyInputSchema = z.strictObject({}).default({})
/** 全部工作区操作都必须明确 Agent 与稳定存储作用域 */
export const AgentWorkspaceTargetSchema = z.strictObject({
  agentId: HostIdSchema.describe('defineElmino 注册的 Agent 键，不是 Agent 的显示名称').meta({ examples: ['writer'] }),
  workspaceId: HostIdSchema.describe('宿主提供的稳定工作区键，查询和运行必须使用同一作用域').meta({ examples: ['default'] }),
})
/** 线程操作不能仅凭 threadId 隐式选择 Agent 或工作区 */
export const ThreadTargetSchema = AgentWorkspaceTargetSchema.extend({
  threadId: ThreadIdSchema.describe('线程标识；新线程由客户端生成，后续查询与运行继续使用原值'),
})

export type AgentWorkspaceTarget = z.infer<typeof AgentWorkspaceTargetSchema>
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>
