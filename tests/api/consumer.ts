/* eslint antfu/no-top-level-await: off -- 仓库外交付程序直接等待迭代器验证 */
import type { ApiClient, ApiTurnCreateInput, RuntimeEventSubscribeInput } from '@elmino/api'
import {
  AgentListResultSchema,
  apiContract,
  ApiThreadListInputSchema,
  ApiThreadListResultSchema,
  ApiTurnCreateInputSchema,
  ApiTurnResumeInputSchema,
  HealthResultSchema,
  RuntimeEventIteratorSchema,
  RuntimeEventSubscribeInputSchema,
} from '@elmino/api'
import { RPC_PATH } from '@elmino/api/paths'

const target = {
  agentId: 'consumer-agent',
  workspaceId: 'consumer-workspace',
  threadId: 'thread_00000000-0000-4000-8000-000000000001',
}
const create: ApiTurnCreateInput = {
  ...target,
  turnId: 'turn_00000000-0000-4000-8000-000000000002',
  input: [{ type: 'text', text: 'hello' }],
}
const subscription: RuntimeEventSubscribeInput = target
type ClientInputPart = Parameters<ApiClient['turn']['create']>[0]['input'][number]
const inputUnionIsTyped: 'unsupported' extends ClientInputPart['type'] ? false : true = true

if (RPC_PATH !== '/rpc' || !inputUnionIsTyped || apiContract.events.subscribe['~orpc'].route.method !== 'GET')
  throw new Error('公开路径、输入联合或订阅方法不正确')
for (const [actual, expected] of [
  [ApiTurnCreateInputSchema.parse(create), create],
  [HealthResultSchema.parse({ status: 'ok' }), { status: 'ok' }],
  [AgentListResultSchema.parse([{ id: 'agent' }]), [{ id: 'agent' }]],
  [RuntimeEventSubscribeInputSchema.parse(subscription), subscription],
  [ApiThreadListResultSchema.parse({ items: [], hasMore: false }), { items: [], hasMore: false }],
]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('公开 Schema 改变了合法输入或输出')
}
if (ApiThreadListInputSchema.safeParse({ agentId: 'a', workspaceId: 'w', limit: 1_001 }).success
  || ApiTurnResumeInputSchema.safeParse({ ...create, response: {} }).success) {
  throw new Error('公开输入接受了超限列表或无效恢复请求')
}

/** 严格 NodeNext 消费完整客户端声明，不创建网络请求 */
async function checkClient(client: ApiClient) {
  const health = await client.meta.health()
  const listing = await client.thread.list({ agentId: 'a', workspaceId: 'w' })
  const state = await client.turn.create(create)
  const stream = await client.events.subscribe(subscription, { lastEventId: 'opaque' })
  return { health: health.status, hasMore: listing.hasMore, threadId: state.threadId, stream }
}
if (typeof checkClient !== 'function')
  throw new Error('客户端类型消费程序不可用')
const parsed = await RuntimeEventIteratorSchema['~standard'].validate((async function* () {
  yield { type: 'stream.reset' as const }
})())
if (parsed.issues)
  throw new Error('事件迭代器未通过公开契约校验')
const item = await parsed.value.next()
if (item.done || item.value.type !== 'stream.reset')
  throw new Error('公开事件迭代器未正确还原控制消息')
