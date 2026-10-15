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
    .route({ method: 'POST', path: '/threads/{threadId}/turns', summary: '创建运行', tags: ['Turn'] })
    .input(ApiTurnCreateInputSchema)
    .output(ThreadStateSchema),
  resume: procedure
    .route({ method: 'POST', path: '/threads/{threadId}/turns/{turnId}/resume', summary: '恢复运行', tags: ['Turn'] })
    .input(ApiTurnResumeInputSchema)
    .output(ThreadStateSchema),
  interrupt: procedure
    .route({ method: 'POST', path: '/threads/{threadId}/turns/{turnId}/interrupt', summary: '中断运行', tags: ['Turn'] })
    .input(ApiTurnInterruptInputSchema)
    .output(ThreadStateSchema),
  steer: procedure
    .route({ method: 'POST', path: '/threads/{threadId}/turns/{turnId}/steer', summary: '引导运行', tags: ['Turn'] })
    .input(ApiTurnSteerInputSchema)
    .output(ApiTurnSteerResultSchema),
}
