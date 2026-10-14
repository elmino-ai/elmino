/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import { createHostServices, defineHostService, defineTools, provideHostService } from '@elmino/tool'
import * as z from 'zod'
import { createMockSandbox } from './sandbox-support.js'

const service = defineHostService<{ prefix: string }>('consumer')
const services = createHostServices([provideHostService(service, { prefix: 'ok:' })])
const tools = defineTools({
  echo: {
    description: 'Echo',
    schema: z.object({ value: z.string() }),
    execute: ({ value }, context) => `${context.services?.require(service).prefix}${value}`,
  },
})
const result = await tools.handlers.echo.execute({ value: 'published' }, { sandbox: createMockSandbox(), services })
if (result !== 'ok:published' || tools.declarations[0]?.name !== 'echo')
  throw new Error('工具定义、参数和宿主服务无法消费')
let rejected = false
try {
  await tools.handlers.echo.execute({ value: 2 }, { sandbox: createMockSandbox() })
}
catch { rejected = true }
if (!rejected)
  throw new Error('工具参数校验未生效')
