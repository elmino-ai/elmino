/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者验证真实 HTTP 端口 */
import { Client } from '@elmino/sdk'
import { AgentServer } from '@elmino/server'
import { listen } from '@elmino/server/node'

const server = AgentServer.create({
  agents: {},
  authorize: ({ request }) => request.headers.get('authorization') === 'Bearer fake-consumer-key',
  resolveWorkspace: () => { throw new Error('健康检查不应打开工作区') },
  resolveModel: () => { throw new Error('健康检查不应装配模型') },
})
const listener = await listen({ server })
try {
  const client = Client.create({ baseUrl: listener.url, apiKey: 'fake-consumer-key' })
  if ((await client.rpc.meta.health({})).status !== 'ok')
    throw new Error('打包后的 Server 无法通过真实 SDK 健康检查')
  let denied = false
  try {
    await Client.create({ baseUrl: listener.url }).rpc.meta.health({})
  }
  catch (error) {
    denied = typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  }
  if (!denied)
    throw new Error('真实网络请求绕过了宿主鉴权')
  await server.close()
  const response = await fetch(`${listener.url}/rpc/meta/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: {} }),
  })
  if (response.status !== 503)
    throw new Error('关闭后的 Server 仍接受网络请求')
}
finally {
  await server.close()
  await listener.close()
}
