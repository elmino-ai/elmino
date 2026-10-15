import { ThreadListItemSchema, ThreadStateSchema } from '@elmino/protocol'
import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { AgentWorkspaceTargetSchema, ThreadTargetSchema } from '../contract/schema'

/** 稳定前缀列表，limit 由宿主传给仓储，不声明尚未实现的游标语义 */
export const ApiThreadListInputSchema = AgentWorkspaceTargetSchema.extend({
  archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
})
export const ApiThreadListResultSchema = z.object({
  items: z.array(ThreadListItemSchema),
  hasMore: z.boolean(),
})

/** 读取契约复用已有线程 wire Schema */
export const threadContract = {
  list: procedure
    .route({ method: 'GET', path: '/threads', summary: '列出线程', tags: ['Thread'] })
    .input(ApiThreadListInputSchema)
    .output(ApiThreadListResultSchema),
  get: procedure
    .route({ method: 'GET', path: '/threads/{threadId}', summary: '读取线程', tags: ['Thread'] })
    .input(ThreadTargetSchema)
    .output(ThreadStateSchema),
}

export type ApiThreadListInput = z.infer<typeof ApiThreadListInputSchema>
export type ApiThreadListResult = z.infer<typeof ApiThreadListResultSchema>
