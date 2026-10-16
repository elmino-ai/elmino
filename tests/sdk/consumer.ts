/* eslint antfu/no-top-level-await: off -- 仓库外浏览器与 Node.js 消费者顺序验收公开入口 */
import type {
  ClientInteraction,
  ClientRun,
  ClientRunOptions,
  ClientRunResult,
  ClientThread,
  ClientThreadRunOptions,
  ThreadWatchOptions,
} from '@elmino/sdk'
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
  client.rpc.turn.cancel,
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

// 高阶入口及其公开类型必须同样能在仓库外由 NodeNext 与浏览器构建消费
const reason = new Error('消费者只验证取消，不提交远端任务')
const runOptions: ClientRunOptions = {
  agentId: 'assistant',
  workspaceId: 'workspace',
  input: '普通输入无需自行组装消息片段',
  signal: AbortSignal.abort(reason),
}
const requestCount = requests.length
await client.run(runOptions).then(
  (result: ClientRunResult) => {
    throw new Error(`已取消的运行不应返回结果：${result.threadId}/${result.turnId}/${result.status}`)
  },
  (error: unknown) => {
    if (error !== reason)
      throw new Error('SDK 未保留取消原因', { cause: error })
  },
)
if (requests.length !== requestCount)
  throw new Error('已取消的 run 不应建立连接或提交任务')

// 会话与执行句柄同样只能依赖公开包；预取消时不产生网络请求
const thread: ClientThread = client.thread({ agentId: 'assistant', workspaceId: 'workspace', threadId: event.threadId })
const options: ClientThreadRunOptions = { signal: AbortSignal.abort(reason), turnId: event.turnId }
const task: ClientRun = thread.start('保留线程和运行身份，供稍后重新连接', options)
if (task.threadId !== event.threadId || task.turnId !== event.turnId)
  throw new Error('执行句柄没有保留提交前的固定身份')
const settled = await Promise.allSettled([task.accepted, task.completed])
if (settled.some(value => value.status !== 'rejected' || value.reason !== reason))
  throw new Error('预取消的执行应同时拒绝接纳和等待，并保留原因')
const watchOptions: ThreadWatchOptions = { signal: options.signal }
thread.watch(() => undefined, watchOptions)()
if (requests.length !== requestCount)
  throw new Error('已取消的会话运行与观察不应产生网络请求')

// 公开交互类型必须包含原 Turn 和中断快照，便于界面安全保存审批身份
function interactionId(interaction: ClientInteraction): string {
  return `${interaction.turnId}/${interaction.interrupt.id}`
}
if (typeof interactionId !== 'function' || [
  client.health,
  client.listAgents,
  client.listThreads,
  thread.run,
  thread.start,
  thread.attach,
  thread.get,
  thread.watch,
  thread.resume,
  thread.approve,
  thread.reject,
  thread.respond,
  thread.cancel,
  task.interrupt,
  task.steer,
  task.detach,
].some(method => typeof method !== 'function')) {
  throw new Error('SDK 缺少会话、审批或执行控制入口')
}
