import { z } from 'zod'
import { procedure } from '../contract/procedure'
import { EmptyInputSchema } from '../contract/schema'

/** 服务进程能够接收请求，不代表模型或工作区已连接 */
export const HealthResultSchema = z.object({ status: z.literal('ok').describe('服务能够接收请求，不表示模型或工作区已连接') })

/** 最小服务存活契约 */
export const metaContract = {
  health: procedure
    .route({
      method: 'GET',
      path: '/health',
      summary: '检查服务状态',
      description: '检查 HTTP 服务能否接收请求；不会调用模型或打开工作区，也不代表外部模型服务可用。鉴权规则与其他业务接口一致',
      tags: ['Meta'],
    })
    .input(EmptyInputSchema)
    .output(HealthResultSchema),
}
