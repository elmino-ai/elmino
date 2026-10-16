/* eslint antfu/no-top-level-await: off -- 独立进程验收只通过公开产物启动服务 */
import { defineElmino } from '@elmino/core'
import { defineServer } from '@elmino/server'

const elmino = defineElmino({
  agents: {},
  workspace: () => { throw new Error('健康检查不应打开工作区') },
  models: () => { throw new Error('健康检查不应装配模型') },
})
const server = defineServer({ elmino, apiKey: null, corsOrigins: [] })
const url = await server.start({ port: 0, hostname: '127.0.0.1' })
process.send?.({ url })
