import type { z } from 'zod'
import { RuntimeStreamMessageSchema, ThreadIdSchema } from '@elmino/protocol'
import { eventIterator } from '@orpc/contract'
import { procedure } from '../contract/procedure'
import { AgentWorkspaceTargetSchema } from '../contract/schema'

/** 始终限定存储作用域，threadId 可进一步限制事件；LastEventId 属于传输元数据 */
export const RuntimeEventSubscribeInputSchema = AgentWorkspaceTargetSchema.extend({
  threadId: ThreadIdSchema.describe('可选的线程过滤条件；省略时订阅整个 Agent 工作区的事件').optional(),
})
export const RuntimeEventIteratorSchema = eventIterator(RuntimeStreamMessageSchema)

/** 可恢复的结构化运行事件订阅 */
export const eventContract = {
  subscribe: procedure
    .route({
      method: 'GET',
      path: '/events',
      summary: '订阅运行事件',
      description: '以 SSE 订阅指定 Agent 和工作区的事件，threadId 可进一步限定线程。重连时通过 Last-Event-ID 请求头提交上次收到的游标；收到 stream.reset 时重新查询线程快照，再继续接收事件。取消订阅只停止观察，不会取消 Agent 任务',
      tags: ['Event'],
    })
    .input(RuntimeEventSubscribeInputSchema)
    .output(RuntimeEventIteratorSchema),
}

export type RuntimeEventSubscribeInput = z.infer<typeof RuntimeEventSubscribeInputSchema>
