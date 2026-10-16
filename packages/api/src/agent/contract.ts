import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { EmptyInputSchema, HostIdSchema } from '../contract/schema'

/** 宿主提供的 Agent 公开说明，不暴露工具执行器与身份 Prompt */
export const AgentInfoSchema = z.object({
  id: HostIdSchema.describe('defineElmino 注册的 Agent 键，提交运行时填写到 agentId').meta({ examples: ['writer'] }),
  name: z.string().describe('供界面显示的 Agent 名称').meta({ examples: ['写作助手'] }).optional(),
  description: z.string().describe('Agent 的公开能力说明，不包含内部指令或工具执行器').optional(),
})

export const AgentListResultSchema = z.array(AgentInfoSchema)

/** Agent 目录契约 */
export const agentContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/agents',
      summary: '列出智能体',
      description: '列出当前 Elmino 实例注册的 Agent 及其公开说明，不会调用模型或打开工作区；返回的 id 用于后续线程与运行请求',
      tags: ['Agent'],
    })
    .input(EmptyInputSchema)
    .output(AgentListResultSchema),
}

export type AgentInfo = z.infer<typeof AgentInfoSchema>
