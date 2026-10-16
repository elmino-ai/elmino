import { ThreadStateSchema } from '@elmino/protocol'
import { procedure } from '../contract/procedure'
import {
  ApiTurnCreateInputSchema,
  ApiTurnInterruptInputSchema,
  ApiTurnResumeInputSchema,
  ApiTurnSteerInputSchema,
  ApiTurnSteerResultSchema,
} from './schema'

/** 创建与恢复返回接纳后的线程事实，执行终态通过事件流与重新读取观察 */
export const turnContract = {
  create: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/turns',
      summary: '创建运行',
      description: '创建新线程或向已有线程提交一次运行。返回值表示任务已接纳，不代表执行完成；通过事件订阅或重新读取线程观察工具、回复和终态',
      tags: ['Turn'],
    })
    .input(ApiTurnCreateInputSchema)
    .output(ThreadStateSchema),
  resume: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/turns/{turnId}/resume',
      summary: '恢复运行',
      description: '使用当前 interruptId 和交互回复恢复原运行。继续使用持久化的模型与权限快照，不能通过恢复请求切换模型或提高权限；返回接纳后的线程状态，终态通过事件或查询观察',
      tags: ['Turn'],
    })
    .input(ApiTurnResumeInputSchema)
    .output(ThreadStateSchema),
  interrupt: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/turns/{turnId}/interrupt',
      summary: '中断运行',
      description: '请求停止指定线程中的准确 Turn，不会自动选取其他运行。返回接纳中断后的线程状态，最终是否完成取消以事件或重新查询的运行状态为准',
      tags: ['Turn'],
    })
    .input(ApiTurnInterruptInputSchema)
    .output(ThreadStateSchema),
  steer: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/turns/{turnId}/steer',
      summary: '引导运行',
      description: '向指定的进行中 Turn 追加引导消息，返回已接纳的消息标识。引导不会新建独立运行，也不替换正在执行的工具；不支持引导的运行状态会返回冲突错误',
      tags: ['Turn'],
    })
    .input(ApiTurnSteerInputSchema)
    .output(ApiTurnSteerResultSchema),
}
