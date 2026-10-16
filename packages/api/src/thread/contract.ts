import { ThreadListItemSchema, ThreadStateSchema } from '@elmino/protocol'
import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { AgentWorkspaceTargetSchema, ThreadTargetSchema } from '../contract/schema'

/** 稳定前缀列表，limit 由宿主传给仓储，不声明尚未实现的游标语义 */
export const ApiThreadListInputSchema = AgentWorkspaceTargetSchema.extend({
  archived: z.boolean().describe('可选的归档状态过滤条件；省略时使用仓储默认列表范围').optional(),
  limit: z.number().int().min(1).max(1_000).describe('最多返回的线程数，范围 1 到 1000；接口使用前缀列表，不提供分页游标').meta({ examples: [20] }).optional(),
})
export const ApiThreadListResultSchema = z.object({
  items: z.array(ThreadListItemSchema).describe('线程元信息与运行摘要，不包含完整消息历史'),
  hasMore: z.boolean().describe('当前结果之后是否仍有线程；增加 limit 可读取更大的前缀范围'),
})

/** 读取契约复用已有线程 wire Schema */
export const threadContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/threads',
      summary: '列出线程',
      description: '列出指定 Agent 和工作区中的线程摘要，可按归档状态过滤并限制数量；完整消息与运行历史使用读取线程接口获取',
      tags: ['Thread'],
    })
    .input(ApiThreadListInputSchema)
    .output(ApiThreadListResultSchema),
  get: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}',
      summary: '读取线程',
      description: '读取指定 Agent、工作区和线程的持久化快照，包含消息、运行、工具交互中断与子线程摘要；事件流重置后使用此接口重建当前状态',
      tags: ['Thread'],
    })
    .input(ThreadTargetSchema)
    .output(ThreadStateSchema),
}

export type ApiThreadListInput = z.infer<typeof ApiThreadListInputSchema>
export type ApiThreadListResult = z.infer<typeof ApiThreadListResultSchema>
