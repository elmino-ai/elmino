import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { EmptyInputSchema, HostIdSchema } from '../contract/schema'

/** 宿主提供的 Agent 公开说明，不暴露工具执行器与身份 Prompt */
export const AgentInfoSchema = z.object({
  id: HostIdSchema,
  name: z.string().optional(),
  description: z.string().optional(),
})

export const AgentListResultSchema = z.array(AgentInfoSchema)

/** Agent 目录契约 */
export const agentContract = {
  list: procedure
    .route({ method: 'GET', path: '/agents', summary: '列出智能体', tags: ['Agent'] })
    .input(EmptyInputSchema)
    .output(AgentListResultSchema),
}

export type AgentInfo = z.infer<typeof AgentInfoSchema>
