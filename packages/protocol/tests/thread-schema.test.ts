import type { ThreadMessage, ThreadPart } from '@elmino/store'
import type { ThreadChildState, ThreadState } from '@elmino/thread'
import {
  ThreadChildStateSchema,
  ThreadContextBudgetSchema,
  ThreadMessageSchema,
  ThreadPartWireSchema,
  ThreadStateSchema,
  ThreadUsagePayloadSchema,
} from '@elmino/protocol'
import { createId } from '@elmino/shared'
import { createTokenUsage, DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import { expect, test } from 'vitest'

const now = '2026-10-15T08:00:00.000Z'
const threadId = createId('thread')
const turnId = createId('turn')
const messageId = createId('msg')
const toolCallId = createId('tool')
const otherThreadId = createId('thread')
const otherTurnId = createId('turn')
const otherMessageId = createId('msg')

/** 全部片段共用同一消息归属，用类型矩阵防止领域联合新增成员后遗漏 wire 校验 */
const base = {
  id: createId('part'),
  messageId,
  threadId,
  turnId,
  seq: 0,
  status: 'completed' as const,
  createdAt: now,
  updatedAt: now,
}
const parts = {
  text: { ...base, type: 'text', text: '你好' },
  error: { ...base, type: 'error', text: '失败' },
  reasoning: { ...base, type: 'reasoning', text: '推理', metadata: { signature: 'opaque' } },
  mention: { ...base, type: 'mention', pluginId: 'skill', resourceId: 'review', trigger: '@', label: '代码审查' },
  image: { ...base, type: 'image', name: 'test.png', mime: 'image/png', url: 'data:image/png;base64,AA==' },
  document: {
    ...base,
    type: 'document',
    name: 'custom.any',
    extension: 'host-defined',
    artifactId: createId('artifact'),
  },
  tool: { ...base, type: 'tool', toolName: 'read', toolCallId, providerCallId: 'call_native', args: { path: 'a.txt' } },
  plugin: { ...base, type: 'plugin', pluginId: 'plan', name: 'plan', data: { items: [] } },
  event: { ...base, type: 'event', title: '活动', payload: { progress: 1 } },
} satisfies { [Type in ThreadPart['type']]: Extract<ThreadPart, { type: Type }> }
const message: ThreadMessage = {
  id: messageId,
  threadId,
  turnId,
  role: 'user',
  kind: 'normal',
  status: 'completed',
  parts: Object.values(parts).map((part, seq) => ({ ...part, id: createId('part'), seq })),
  metadata: {},
  createdAt: now,
  updatedAt: now,
}
const usage = createTokenUsage({ input: 10, output: 4, cacheRead: 2 })
const interrupt = {
  id: createId('interrupt'),
  turnId,
  kind: 'interaction' as const,
  interaction: 'question',
  ownerId: 'host-extension',
  status: 'pending' as const,
  reason: '等待确认',
  payload: { question: '继续吗' },
  createdAt: now,
  resumableWith: ['interaction'] as ['interaction'],
}
const thread: ThreadState = {
  threadId,
  agentId: 'custom-agent',
  workspaceId: 'custom-workspace',
  workspaceRoot: '/workspace',
  cwd: '/workspace',
  pinned: false,
  unreadAt: null,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  lastInteractionAt: now,
  messages: [message],
  turns: [{ id: turnId, agentId: 'custom-agent', status: 'interrupted' }],
  children: [],
  extensions: { notes: { count: 1 } },
  settings: { ...DEFAULT_THREAD_SETTINGS, modelId: 'custom-model' },
  runtime: {
    agentId: 'custom-agent',
    turnId,
    status: 'interrupted',
    approvalMode: 'request',
    usage,
    taskUsage: usage,
    interrupt,
  },
}

test('完整消息矩阵保留全部领域片段与混合输入，不限制宿主文档扩展名', () => {
  expect(ThreadMessageSchema.parse(message)).toEqual(message)
  for (const part of message.parts)
    expect(ThreadPartWireSchema.parse(part)).toEqual(part)
  for (const id of [`${messageId}:reasoning`, `${messageId}:tool:call_native`, 'plugin:plan:call_native'])
    expect(ThreadPartWireSchema.safeParse({ ...parts.tool, id }).success).toBe(true)
})

test.each([
  { threadId: otherThreadId },
  { turnId: otherTurnId },
  { messageId: otherMessageId },
])('消息拒绝片段的交叉归属 %j', (patch) => {
  expect(ThreadMessageSchema.safeParse({ ...message, parts: [{ ...parts.text, ...patch }] }).success).toBe(false)
})

test.each([
  { id: 'part_legacy' },
  { id: `${otherMessageId}:reasoning` },
  { messageId: 'msg_legacy' },
  { threadId: 'thread_legacy' },
  { turnId: 'turn_legacy' },
  { toolCallId: 'tool_legacy' },
])('独立片段拒绝伪造内核 ID 与派生归属 %j', (patch) => {
  expect(ThreadPartWireSchema.safeParse({ ...parts.tool, ...patch }).success).toBe(false)
})

test('线程接受可选标题、新扩展字段与宿主配置键，并保留设置命名空间原键', () => {
  const value = { ...thread, settings: { ...thread.settings, pluginSettings: { ' host ': { enabled: true } } } }
  expect(ThreadStateSchema.parse(value)).toEqual(value)
  expect(ThreadStateSchema.safeParse({ ...thread, title: undefined }).success).toBe(true)
  expect(ThreadStateSchema.safeParse({ ...thread, extensions: undefined, plugins: {} }).success).toBe(false)
  // 领域允许轻投影只携带当前运行；不能要求未附带的时间线包含它
  expect(ThreadStateSchema.safeParse({ ...thread, messages: [], turns: [] }).success).toBe(true)
})

test.each([
  { messages: [{ ...message, threadId: otherThreadId }] },
  { turns: [] },
  { turns: [{ ...thread.turns[0], agentId: 'another-agent' }] },
  { runtime: { ...thread.runtime, agentId: 'another-agent' } },
  { runtime: { ...thread.runtime, turnId: otherTurnId } },
  { settings: { ...thread.settings, pluginSettings: { ' ': {} } } },
])('完整线程拒绝交叉归属与无效设置 %j', (patch) => {
  expect(ThreadStateSchema.safeParse({ ...thread, ...patch }).success).toBe(false)
})

test.each([() => undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, { nested: undefined }])(
  '跨端扩展、metadata、工具参数和活动载荷拒绝非 JSON 值 %s',
  (invalid) => {
    expect(ThreadStateSchema.safeParse({ ...thread, extensions: { notes: { value: invalid } } }).success).toBe(false)
    expect(ThreadMessageSchema.safeParse({ ...message, metadata: { value: invalid } }).success).toBe(false)
    expect(ThreadPartWireSchema.safeParse({ ...parts.tool, args: invalid }).success).toBe(false)
    expect(ThreadPartWireSchema.safeParse({ ...parts.event, payload: invalid }).success).toBe(false)
  },
)

test('循环扩展数据拒绝而不递归溢出', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(ThreadStateSchema.safeParse({ ...thread, extensions: { notes: cyclic } }).success).toBe(false)
})

test('领域原生输出允许省略可选字段，嵌套 JSON 仍不允许有损值', () => {
  const tool = { ...parts.tool, error: undefined, decision: undefined, durationMs: undefined }
  const raw = {
    ...thread,
    messages: [{
      ...message,
      parts: [tool, { ...parts.reasoning, id: createId('part'), seq: 1, metadata: undefined }],
    }],
    runtime: { ...thread.runtime, interrupt: { ...interrupt, ownerId: undefined, resolvedAt: undefined } },
  }
  expect(ThreadStateSchema.safeParse(raw).success).toBe(true)
  for (const args of [{ bad: Number.NaN }, { bad: undefined }])
    expect(ThreadPartWireSchema.safeParse({ ...tool, args }).success).toBe(false)
  expect(ThreadStateSchema.safeParse({
    ...raw,
    runtime: { ...raw.runtime, interrupt: { ...interrupt, payload: { bad: undefined } } },
  }).success).toBe(false)
})

test('子线程中断绑定自己的 Turn，允许与外层父 Turn 不同', () => {
  const child: ThreadChildState = {
    ownerId: 'subagent',
    threadId: otherThreadId,
    turnId: otherTurnId,
    parentToolCallId: toolCallId,
    status: 'interrupted',
    interrupt: { ...interrupt, turnId: otherTurnId },
    data: {},
    createdAt: now,
    updatedAt: now,
  }
  expect(ThreadChildStateSchema.parse(child)).toEqual(child)
  expect(ThreadStateSchema.safeParse({ ...thread, children: [child] }).success).toBe(true)
  expect(ThreadChildStateSchema.safeParse({ ...child, interrupt }).success).toBe(false)
  expect(ThreadChildStateSchema.safeParse({ ...child, data: [] }).success).toBe(false)
})

test.each([
  { createdAt: '2026-02-31T08:00:00.000Z' },
  { resolvedAt: 'tomorrow' },
  { payload: undefined },
  { resumableWith: [] },
])('Interaction 拒绝无效日期或缺失恢复数据 %j', (patch) => {
  expect(ThreadStateSchema.safeParse({
    ...thread,
    runtime: { ...thread.runtime, interrupt: { ...interrupt, ...patch } },
  }).success).toBe(false)
})

test('用量与预算边界拒绝非有限、负数、错误时间，允许超预算与带时区日期', () => {
  expect(ThreadUsagePayloadSchema.parse({ usage, taskUsage: usage })).toEqual({ usage, taskUsage: usage })
  for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])
    expect(ThreadUsagePayloadSchema.safeParse({ usage: { ...usage, input }, taskUsage: usage }).success).toBe(false)
  const budget = {
    usedTokens: 200,
    maxTokens: 100,
    remainingTokens: 0,
    messageCount: 1,
    estimation: 'provider',
    updatedAt: now,
  }
  expect(ThreadContextBudgetSchema.parse(budget)).toEqual(budget)
  expect(ThreadContextBudgetSchema.safeParse({ ...budget, updatedAt: '2026-10-15T16:00:00+08:00' }).success).toBe(true)
  for (const patch of [{ remainingTokens: -1 }, { usedTokens: Number.NaN }, { updatedAt: '2026-02-31T08:00:00Z' }])
    expect(ThreadContextBudgetSchema.safeParse({ ...budget, ...patch }).success).toBe(false)
})
