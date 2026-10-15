import {
  apiContract,
  ApiThreadListInputSchema,
  ApiThreadListResultSchema,
  ApiTurnCreateInputSchema,
  ApiTurnInterruptInputSchema,
  ApiTurnResumeInputSchema,
  ApiTurnSteerInputSchema,
  EmptyInputSchema,
  RuntimeEventIteratorSchema,
  RuntimeEventSubscribeInputSchema,
  ThreadInputContentSchema,
} from '@elmino/api'
import { API_DOCS_PATH, API_PATH, API_SPEC_PATH, RPC_PATH } from '@elmino/api/paths'
import { createId } from '@elmino/shared'
import { expect, test } from 'vitest'

const target = { agentId: 'my-agent', workspaceId: 'my-workspace', threadId: createId('thread') }
const turnId = createId('turn')
const creating = { ...target, turnId, input: [{ type: 'text' as const, text: '你好' }] }
const resuming = { ...target, turnId, interruptId: createId('interrupt'), response: { answer: 'yes' } }

test('契约只包含通用五域且所有客户端共用独立 RPC 挂载路径', () => {
  expect(Object.keys(apiContract)).toEqual(['meta', 'agent', 'thread', 'turn', 'events'])
  expect(RPC_PATH).toBe('/rpc')
  expect([API_PATH, API_DOCS_PATH, API_SPEC_PATH]).toEqual(['/api', '/api/docs', '/api/spec.json'])
  expect(EmptyInputSchema.parse(undefined)).toEqual({})
  expect(apiContract.meta.health['~orpc'].route).toMatchObject({ method: 'GET', path: '/health' })
  expect(apiContract.turn.resume['~orpc'].route).toMatchObject({
    method: 'POST',
    path: '/threads/{threadId}/turns/{turnId}/resume',
  })
})

test('创建接受宿主模型键和客户端 Turn ID，拒绝执行资源注入', () => {
  expect(ApiTurnCreateInputSchema.parse({ ...creating, modelId: 'host-model', approvalMode: 'request' }))
    .toMatchObject({ modelId: 'host-model', turnId })
  for (const patch of [
    { model: {} },
    { credential: 'not-a-key' },
    { location: {} },
    { store: {} },
    { threadId: 'thread_legacy' },
    { turnId: 'turn_legacy' },
    { input: [] },
    { input: [{ type: 'text', text: '' }] },
    { approvalMode: 'unknown' },
  ]) {
    expect(ApiTurnCreateInputSchema.safeParse({ ...creating, ...patch }).success).toBe(false)
  }
})

test.each([
  { type: 'text', text: '保留原文' },
  { type: 'mention', pluginId: 'skills', resourceId: 'review', trigger: '@', label: '审查', data: { nested: [1, true] } },
  { type: 'image', name: 'a.png', mime: 'image/png', data: 'AA==', compress: true },
  { type: 'document', name: 'a.custom', extension: 'host-format', data: 'SGVsbG8=' },
])('公开输入联合覆盖当前领域类型 %j', (value) => {
  expect(ThreadInputContentSchema.parse(value)).toEqual(value)
})

test.each([
  { type: 'image', name: 'a.png', mime: 'image/png', data: 'data:image/png;base64,AA==', compress: true },
  { type: 'image', name: 'a.png', mime: 'image/png', data: 'AA', compress: true },
  { type: 'image', name: 'a.png', mime: 'image/avif', data: 'AA==', compress: true },
  { type: 'document', name: 'a.pdf', extension: 'pdf', data: '' },
  { type: 'document', name: 'a.pdf', extension: 'pdf', data: 'AA===' },
  { type: 'mention', pluginId: 'skills', resourceId: 'review', trigger: '@@', label: '审查' },
])('外部输入拒绝破损附件和无效引用 %j', (value) => {
  expect(ThreadInputContentSchema.safeParse(value).success).toBe(false)
})

test('恢复只接受原身份、中断和真实 JSON，不允许覆盖冻结模型或访问级别', () => {
  expect(ApiTurnResumeInputSchema.parse(resuming)).toEqual(resuming)
  for (const patch of [
    { modelId: 'other' },
    { approvalMode: 'fullAccess' },
    { input: [] },
    { interruptId: 'interrupt_legacy' },
    { response: { answer: undefined } },
    { response: Number.NaN },
    { response: () => 'yes' },
  ]) {
    expect(ApiTurnResumeInputSchema.safeParse({ ...resuming, ...patch }).success).toBe(false)
  }
})

test('控制入口固定三重作用域与准确 Turn，纯文本引导不允许空白', () => {
  const control = { ...target, turnId }
  expect(ApiTurnInterruptInputSchema.parse({ ...control, reason: 'stop' })).toEqual({ ...control, reason: 'stop' })
  expect(ApiTurnSteerInputSchema.parse({ ...control, text: '  新方向  ' }).text).toBe('  新方向  ')
  for (const field of ['agentId', 'workspaceId', 'threadId', 'turnId']) {
    expect(ApiTurnInterruptInputSchema.safeParse({ ...control, [field]: undefined }).success).toBe(false)
  }
  expect(ApiTurnSteerInputSchema.safeParse({ ...control, text: ' ' }).success).toBe(false)
  expect(ApiTurnSteerInputSchema.safeParse({ ...control, text: 'go', input: [] }).success).toBe(false)
})

test('列表使用有上界的稳定前缀，不暴露未实现的 cursor', () => {
  expect(ApiThreadListInputSchema.parse({ agentId: target.agentId, workspaceId: target.workspaceId, limit: 1_000 }))
    .toMatchObject({ limit: 1_000 })
  for (const patch of [{ limit: 0 }, { limit: 1_001 }, { cursor: 'opaque' }]) {
    expect(ApiThreadListInputSchema.safeParse({
      agentId: target.agentId,
      workspaceId: target.workspaceId,
      ...patch,
    }).success).toBe(false)
  }
  const item = {
    ...target,
    pinned: false,
    unreadAt: null,
    archivedAt: null,
    lastInteractionAt: '2026-10-15T08:00:00Z',
    updatedAt: '2026-10-15T08:00:00Z',
    settings: { approvalMode: 'request', subagentMode: 'explicitOnly', pluginSettings: {} },
    runtime: { status: 'idle' },
  }
  expect(ApiThreadListResultSchema.parse({ items: [item], hasMore: false })).toEqual({ items: [item], hasMore: false })
  expect(ApiThreadListResultSchema.safeParse({ items: [item] }).success).toBe(false)
  expect(ApiThreadListResultSchema.safeParse({ items: [{ ...item, updatedAt: 'invalid' }], hasMore: false }).success)
    .toBe(false)
})

test('事件输入显式限定工作区，迭代时继续校验事件 payload', async () => {
  expect(RuntimeEventSubscribeInputSchema.parse(target)).toEqual(target)
  expect(RuntimeEventSubscribeInputSchema.safeParse({ agentId: target.agentId }).success).toBe(false)
  expect(RuntimeEventSubscribeInputSchema.safeParse({ ...target, lastEventId: 'not-input' }).success).toBe(false)
  const valid = RuntimeEventIteratorSchema['~standard'].validate((async function* () {
    yield { type: 'stream.connected' as const }
  })())
  const result = await valid
  if (result.issues)
    throw new Error('合法事件迭代器未通过校验')
  expect(await result.value.next()).toEqual({ done: false, value: { type: 'stream.connected' } })
  const invalid = await RuntimeEventIteratorSchema['~standard'].validate((async function* () {
    yield { type: 'stream.invalid' }
  })())
  if (invalid.issues)
    throw new Error('迭代器对象应在消费时校验其消息')
  await expect(invalid.value.next()).rejects.toThrow()
})

test('API 输出校验接受领域原始工具消息的可选 undefined，不把有损参数当作 JSON', () => {
  const now = '2026-10-15T08:00:00Z'
  const messageId = createId('msg')
  const part = {
    ...target,
    id: createId('part'),
    messageId,
    turnId,
    type: 'tool',
    seq: 0,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    toolName: 'test',
    error: undefined,
    decision: undefined,
    durationMs: undefined,
  }
  const message = {
    id: messageId,
    threadId: target.threadId,
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    metadata: {},
    parts: [part],
  }
  const usage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheWrite: 0,
    cacheRead: 0,
    estimated: 0,
    total: 0,
    cacheHitRate: 0,
  }
  const state = {
    ...target,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    pinned: false,
    unreadAt: null,
    archivedAt: null,
    createdAt: now,
    lastInteractionAt: now,
    updatedAt: now,
    messages: [message],
    turns: [{ id: turnId, agentId: target.agentId, status: 'completed' }],
    children: [],
    extensions: {},
    settings: { approvalMode: 'request', subagentMode: 'explicitOnly', pluginSettings: {} },
    runtime: { agentId: target.agentId, status: 'completed', approvalMode: 'request', usage, taskUsage: usage },
  }
  const schema = apiContract.turn.create['~orpc'].outputSchema
  if (!schema)
    throw new Error('创建运行缺少输出契约')
  expect(schema.safeParse(state).success).toBe(true)
  expect(schema.safeParse({
    ...state,
    messages: [{ ...message, parts: [{ ...part, args: { bad: Number.NaN } }] }],
  }).success).toBe(false)
})

test('HTTP 与 RPC 共用稳定契约，九条路由都有方法、摘要和分类', () => {
  const routes = Object.values(apiContract).flatMap(group => Object.values(group).map(value => value['~orpc'].route))
  expect(routes.map(route => [route.method, route.path])).toEqual([
    ['GET', '/health'],
    ['GET', '/agents'],
    ['GET', '/threads'],
    ['GET', '/threads/{threadId}'],
    ['POST', '/threads/{threadId}/turns'],
    ['POST', '/threads/{threadId}/turns/{turnId}/resume'],
    ['POST', '/threads/{threadId}/turns/{turnId}/interrupt'],
    ['POST', '/threads/{threadId}/turns/{turnId}/steer'],
    ['GET', '/events'],
  ])
  for (const route of routes) {
    expect(route.summary?.trim().length).toBeGreaterThan(0)
    expect(route.tags?.length).toBeGreaterThan(0)
  }
})
