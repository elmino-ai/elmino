import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { EmptyInputSchema } from '../contract/schema'

/** 服务进程能够接收请求，不代表模型或工作区已连接 */
export const HealthResultSchema = z.object({ status: z.literal('ok') })

/** 最小服务存活契约 */
export const metaContract = {
  health: procedure
    .route({ method: 'GET', path: '/health', summary: '检查服务状态', tags: ['Meta'] })
    .input(EmptyInputSchema)
    .output(HealthResultSchema),
}
