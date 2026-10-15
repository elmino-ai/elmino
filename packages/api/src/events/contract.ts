import { RuntimeStreamMessageSchema, THREAD_ID_PATTERN } from '@elmino/protocol'
import { eventIterator } from '@orpc/contract'
import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { AgentWorkspaceTargetSchema } from '../contract/schema'

/** 始终限定存储作用域，threadId 可进一步限制事件；LastEventId 属于传输元数据 */
export const RuntimeEventSubscribeInputSchema = AgentWorkspaceTargetSchema.extend({
  threadId: z.string().regex(THREAD_ID_PATTERN).optional(),
})
export const RuntimeEventIteratorSchema = eventIterator(RuntimeStreamMessageSchema)

/** 可恢复的结构化运行事件订阅 */
export const eventContract = {
  subscribe: procedure
    .route({ method: 'GET', path: '/events', summary: '订阅运行事件', tags: ['Event'] })
    .input(RuntimeEventSubscribeInputSchema)
    .output(RuntimeEventIteratorSchema),
}

export type RuntimeEventSubscribeInput = z.infer<typeof RuntimeEventSubscribeInputSchema>
