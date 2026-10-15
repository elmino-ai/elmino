/* eslint antfu/no-top-level-await: off -- 仓库外浏览器与 Node.js 消费者顺序验收公开入口 */
import { Client } from '@elmino/sdk'

const event = {
  id: 'event_11111111-1111-4111-8111-111111111111',
  type: 'turn.started',
  threadId: 'thread_22222222-2222-4222-8222-222222222222',
  turnId: 'turn_33333333-3333-4333-8333-333333333333',
  createdAt: '2026-10-15T00:00:00.000Z',
  payload: {},
}
const requests: Request[] = []
const cancelled = Promise.withResolvers<void>()
const received = Promise.withResolvers<void>()
const client = Client.create({
  baseUrl: 'https://service.example/prefix/',
  apiKey: 'fake-consumer-key',
  retry: { initialDelayMs: 10, maxDelayMs: 20 },
  fetch: (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.url.endsWith('/events/subscribe')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const frame = [
            'id: stream_44444444-4444-4444-8444-444444444444:1',
            'event: message',
            `data: ${JSON.stringify({ json: event })}`,
            '',
            '',
          ].join('\n')
          controller.enqueue(new TextEncoder().encode(frame))
        },
        cancel() {
          cancelled.resolve()
        },
      })
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    }
    return Promise.resolve(Response.json({ json: { status: 'ok' } }))
  },
})
if ((await client.rpc.meta.health({})).status !== 'ok'
  || requests[0]?.url !== 'https://service.example/prefix/rpc/meta/health'
  || requests[0]?.headers.get('authorization') !== 'Bearer fake-consumer-key') {
  throw new Error('SDK 未按宿主前缀装配类型化 API 和鉴权')
}
// 方法直接来自 ApiClient 契约，不由 SDK 逐项再包装
if ([
  client.rpc.agent.list,
  client.rpc.thread.get,
  client.rpc.thread.list,
  client.rpc.turn.create,
  client.rpc.turn.resume,
  client.rpc.turn.interrupt,
  client.rpc.turn.steer,
].some(method => typeof method !== 'function')) {
  throw new Error('SDK 缺少完整 API 方法')
}
const unsubscribe = client.subscribe({ agentId: 'assistant', workspaceId: 'workspace', threadId: event.threadId }, {
  onEvent(value) {
    if (value.id !== event.id)
      throw new Error('SDK 事件无法通过公开协议消费')
    received.resolve()
  },
  onError: error => received.reject(error),
})
try {
  await received.promise
  if (requests.at(-1)?.url !== 'https://service.example/prefix/rpc/events/subscribe')
    throw new Error('SDK 订阅未使用真实 oRPC endpoint')
}
finally {
  unsubscribe()
}
await cancelled.promise
