/* eslint antfu/no-top-level-await: off -- 独立进程验收只通过公开产物启动服务 */
import { defineServer } from '@elmino/server'

const server = defineServer({
  agents: {},
  workspace: () => { throw new Error('健康检查不应打开工作区') },
  model: () => { throw new Error('健康检查不应装配模型') },
})
const url = await server.start({ port: 0 })
process.send?.({ url })
