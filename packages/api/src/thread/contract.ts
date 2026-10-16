import {
  ThreadListItemSchema,
  ThreadStateSchema,
  ThreadTranscriptPageSchema,
  ThreadTurnRecordSchema,
} from '@elmino/protocol'
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

/** 历史分页使用完整 Turn 边界，游标保持不透明并限制外部输入大小 */
export const ApiThreadTranscriptInputSchema = ThreadTargetSchema.extend({
  cursor: z.string().min(1).max(2_048).describe('上一页返回的更早历史游标，只属于同一智能体、工作区和线程').optional(),
  limit: z.number().int().min(1).max(50).describe('每页完整运行数，默认 10，范围 1 到 50').optional(),
})

/** 历史运行记录按最近创建优先排列 */
export const ApiThreadTurnListResultSchema = z.array(ThreadTurnRecordSchema)

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
  listTurns: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/turns',
      summary: '列出运行记录',
      description: '读取指定会话的持久运行记录，保留冻结的智能体、模型、权限、失败原因与中断信息，按最近创建优先排列；不会返回模型凭据或智能体内部指令',
      tags: ['Thread'],
    })
    .input(ThreadTargetSchema)
    .output(ApiThreadTurnListResultSchema),
  readTranscript: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/transcript',
      summary: '读取会话历史',
      description: '按完整运行边界读取一页会话消息，页内按执行顺序排列；nextCursor 指向更早历史，为 null 时没有更早记录。最新页合并当前运行的流式内容，历史页只读取持久事实',
      tags: ['Thread'],
    })
    .input(ApiThreadTranscriptInputSchema)
    .output(ThreadTranscriptPageSchema),
}

export type ApiThreadListInput = z.infer<typeof ApiThreadListInputSchema>
export type ApiThreadListResult = z.infer<typeof ApiThreadListResultSchema>
export type ApiThreadTranscriptInput = z.infer<typeof ApiThreadTranscriptInputSchema>
