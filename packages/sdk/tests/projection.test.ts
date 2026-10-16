import type { ThreadMessage, ThreadPart } from '@elmino/store'
import type { ThreadState } from '@elmino/thread'
import type { CreateRuntimeEventInput } from '@elmino/thread/events'
import { createId } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import { createRuntimeEvent } from '@elmino/thread/events'
import { expect, test } from 'vitest'
import { ThreadProjection } from '../src/thread/projection'

/**
 * 创建同一线程的权威快照和事件，纯投影测试不读取网络、环境或运行数据
 */
function fixture() {
  // 全部事件和实体共用准确的领域身份，避免测试绕过归属保护
  const threadId = createId('thread')
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const now = '2026-10-16T00:00:00.000Z'
  const usage = { input: 0, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0, estimated: 0, total: 0, cacheHitRate: 0 }
  /** 构造可被协议校验器读取的完整助手消息 */
  const message = (text: string): ThreadMessage => ({
    id: messageId,
    threadId,
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    createdAt: now,
    updatedAt: now,
    metadata: {},
    parts: [{ id: partId, messageId, threadId, turnId, seq: 1, status: 'running', type: 'text', text, createdAt: now, updatedAt: now }],
  })
  /** 构造持久化查询返回的完整线程 */
  const state = (text = ''): ThreadState => ({
    threadId,
    agentId: 'writer',
    workspaceId: 'project',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    pinned: false,
    unreadAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    lastInteractionAt: now,
    messages: [message(text)],
    turns: [{ id: turnId, agentId: 'writer', status: 'running' }],
    children: [],
    extensions: {},
    settings: { ...DEFAULT_THREAD_SETTINGS },
    runtime: { agentId: 'writer', turnId, status: 'running', approvalMode: 'request', usage, taskUsage: usage },
  })
  /** 按当前线程归属生成真实运行事件 */
  const event = (input: Omit<CreateRuntimeEventInput, 'threadId'>) => createRuntimeEvent({ threadId, ...input })
  /** 完整消息事件可以建立当前连接的正文锚点 */
  const update = (text: string) => event({ type: 'message.updated', turnId, messageId, payload: { message: message(text) } })
  /** 正文增量没有偏移，不能直接接到查询快照上 */
  const delta = (text: string) => event({ type: 'message.part.delta', turnId, messageId, partId, payload: { delta: { text } } })
  return { threadId, turnId, messageId, partId, now, message, state, event, update, delta }
}

test('相同快照与消息复用原引用，局部正文变化不影响其他实体或旧快照', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state()
  const sibling = { ...data.message('另一条消息'), id: createId('msg'), parts: [] }
  initial.messages.push(sibling)
  projection.reset(initial)
  const duplicate = { ...data.state(), messages: [data.message(''), { ...sibling }] }
  expect(projection.reset(duplicate)).toBe(initial)
  expect(projection.apply(data.update('')).state).toBe(initial)
  const next = projection.apply(data.delta('A')).state!
  expect(next).not.toBe(initial)
  expect(next.messages).not.toBe(initial.messages)
  expect(next.messages[1]).toBe(sibling)
  expect(next.runtime).toBe(initial.runtime)
  expect(next.turns).toBe(initial.turns)
  expect(next.messages[0]!.parts[0]).toMatchObject({ text: 'A' })
  expect(initial.messages[0]!.parts[0]).toMatchObject({ text: '' })
})

test('重复事件只消费一次，正文锚点连续接纳空白与文本', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  projection.reset(data.state())
  projection.apply(data.update(''))
  const first = data.delta('\n  ')
  const accepted = projection.apply(first).state
  expect(projection.apply(first).state).toBe(accepted)
  projection.apply(data.delta('代码'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: '\n  代码' })
})

test('查询快照不能作为无偏移正文锚点，完整事件追上快照后才继续展示', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state('ABC')
  projection.reset(initial)
  expect(projection.apply(data.delta('B'))).toEqual({ state: initial, refresh: false })
  expect(projection.apply(data.update('A')).state).toBe(initial)
  expect(projection.apply(data.delta('B')).state).toBe(initial)
  expect(projection.apply(data.delta('C')).state).toBe(initial)
  expect(projection.apply(data.delta('D')).state?.messages[0]?.parts[0]).toMatchObject({ text: 'ABCD' })
  projection.reset(data.state('ABCDE'))
  expect(projection.apply(data.delta('E')).state?.messages[0]?.parts[0]).toMatchObject({ text: 'ABCDE' })
})

test('正文锚点与已知正文冲突时要求校准，不按长度覆盖已有内容', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  projection.reset(data.state('ABC'))
  projection.apply(data.update('A'))
  const previous = projection.getSnapshot()
  expect(projection.apply(data.delta('X'))).toEqual({ state: previous, refresh: true })
})

test('普通读取和完整线程事件保留同一连接锚点，领先快照由缓冲增量追赶', () => {
  // 同一连接已经消费 A，普通读取领先到 ABC，但 B/C 仍在事件队列中
  const data = fixture()
  const projection = ThreadProjection.create()
  projection.reset(data.state())
  projection.apply(data.update(''))
  projection.apply(data.delta('A'))
  projection.merge(data.state('ABC'))
  projection.apply(data.delta('B'))
  projection.apply(data.delta('C'))
  projection.apply(data.delta('D'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: 'ABCD' })
  // 完整线程事件同样不能清除已知锚点，下一段继续追加而非等待消息收尾
  projection.apply(data.event({ type: 'thread.updated', turnId: data.turnId, payload: data.state('ABCD') }))
  projection.apply(data.delta('E'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: 'ABCDE' })
})

test('普通合并保留近期事件去重，结构删除会移除正文锚点', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  projection.reset(data.state())
  projection.apply(data.update(''))
  const event = data.delta('A')
  projection.apply(event)
  projection.merge(data.state('A'))
  projection.apply(event)
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: 'A' })
  // 快照移除part后即便相同身份随后重新出现，也必须等待新的完整事件建立锚点
  projection.merge({ ...data.state(), messages: [] })
  projection.merge(data.state())
  projection.apply(data.delta('B'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: '' })
})

test('只有清空或删除递增读取代次，普通合并和带快照的流reset不使当前读取失效', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initialEpoch = projection.getEpoch()
  projection.reset(data.state())
  projection.merge(data.state('A'))
  expect(projection.getEpoch()).toBe(initialEpoch)
  projection.reset()
  expect(projection.getEpoch()).toBe(initialEpoch + 1)
  projection.merge(data.state())
  projection.apply(data.event({ type: 'thread.deleted', payload: { workspaceId: 'project' } }))
  expect(projection.getEpoch()).toBe(initialEpoch + 2)
  expect(projection.getSnapshot()).toBeUndefined()
})

test('未创建会话的空基线不使并行创建失效，真实删除在无状态时仍推进读取代次', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initialEpoch = projection.getEpoch()
  projection.reset()
  expect(projection.getEpoch()).toBe(initialEpoch)
  projection.apply(data.event({ type: 'thread.deleted', payload: { workspaceId: 'project' } }))
  expect(projection.getEpoch()).toBe(initialEpoch + 1)
})

test('真实连接重置只清一次锚点，本地校准和同连接的其他观察者不会重置它', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const connection = {}
  projection.reset(data.state())
  projection.resetConnection(connection)
  projection.apply(data.update(''))
  projection.apply(data.delta('A'))
  // 本地校准没有新传输身份，同一重连身份也不能再次清空已建立锚点
  projection.resetConnection()
  projection.resetConnection(connection)
  projection.apply(data.delta('B'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  const epoch = projection.getEpoch()
  projection.resetConnection({})
  projection.apply(data.delta('C'))
  expect(projection.getSnapshot()?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  expect(projection.getEpoch()).toBe(epoch)
})

test('同毫秒旧消息和片段不能把已完成事实回退为运行中', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const final = data.state('完整回复')
  final.messages[0]!.status = 'completed'
  final.messages[0]!.parts[0]!.status = 'completed'
  final.runtime.status = 'completed'
  projection.reset(final)
  expect(projection.apply(data.update('旧回复')).state).toBe(final)
  const part = { ...data.message('').parts[0]!, text: '旧片段' }
  expect(projection.apply(data.event({
    type: 'message.part.updated',
    turnId: data.turnId,
    messageId: data.messageId,
    partId: data.partId,
    payload: { part },
  })).state).toBe(final)
  expect(projection.reset(data.state('旧快照'))).toBe(final)
})

test('更新消息的旧片段不覆盖已知较新片段，真正变化只替换目标part', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state('更新正文')
  initial.messages[0]!.parts[0]!.updatedAt = '2026-10-16T00:00:01.000Z'
  const previous = initial.messages[0]!.parts[0]
  projection.reset(initial)
  const message = data.message('旧正文')
  message.updatedAt = '2026-10-16T00:00:02.000Z'
  message.parts.push({ ...message.parts[0]!, id: createId('part'), seq: 2 })
  const next = projection.apply(data.event({
    type: 'message.updated',
    turnId: data.turnId,
    messageId: data.messageId,
    payload: { message },
  })).state!
  expect(next.messages[0]!.parts[0]).toBe(previous)
  expect(next.messages[0]!.parts[1]).toMatchObject({ seq: 2 })
  expect(initial.messages[0]!.parts).toHaveLength(1)
})

test('更旧线程快照保持已知状态，其他线程事件不会污染当前投影', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const current = data.state('新正文')
  current.updatedAt = '2026-10-16T00:00:01.000Z'
  projection.reset(current)
  const stale = data.event({ type: 'thread.updated', turnId: data.turnId, payload: data.state('旧正文') })
  expect(projection.apply(stale).state).toBe(current)
  expect(projection.apply({ ...data.delta('串线'), threadId: createId('thread') })).toEqual({ state: current, refresh: false })
})

test('完整线程事件更新结构并复用未变化正文，快照删除不会复活旧消息', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state('ABC')
  projection.reset(initial)
  const next = { ...data.state('A'), title: '更新标题' }
  const result = projection.apply(data.event({ type: 'thread.updated', turnId: data.turnId, payload: next }))
  expect(result.refresh).toBe(false)
  expect(result.state?.title).toBe('更新标题')
  expect(result.state?.messages[0]).toBe(initial.messages[0])
  expect(projection.reset({ ...next, messages: [] })?.messages).toEqual([])
})

test('工具输出使用字符偏移幂等合并，重放不重复、缺口和工具身份冲突要求校准', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state()
  const toolCallId = createId('tool')
  const tool: ThreadPart = {
    ...data.message('').parts[0]!,
    type: 'tool',
    toolName: 'read',
    toolCallId,
    output: 'AB',
  }
  initial.messages[0]!.parts = [tool]
  projection.reset(initial)
  /** 输出携带明确字符偏移，可以安全接在查询快照上 */
  const output = (text: string, offset: number) => data.event({
    type: 'message.part.delta',
    turnId: data.turnId,
    messageId: data.messageId,
    partId: data.partId,
    toolCallId,
    payload: { delta: { output: text, offset } },
  })
  expect(projection.apply(output('AB', 0)).state).toBe(initial)
  const accepted = projection.apply(output('C', 2)).state!
  expect(accepted.messages[0]?.parts[0]).toMatchObject({ output: 'ABC' })
  expect(projection.apply(output('C', 2)).state).toBe(accepted)
  expect(projection.apply(output('D', 9))).toEqual({ state: accepted, refresh: true })
  expect(projection.apply(output('X', 1))).toEqual({ state: accepted, refresh: true })
  expect(projection.apply({ ...output('D', 3), toolCallId: createId('tool') })).toEqual({ state: accepted, refresh: true })
  expect(tool.output).toBe('AB')
})

test('未知归属请求权威快照而不合成消息或片段', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  expect(projection.apply(data.delta('A'))).toEqual({ state: undefined, refresh: true })
  const initial = data.state()
  initial.messages = []
  projection.reset(initial)
  expect(projection.apply(data.delta('A'))).toEqual({ state: initial, refresh: true })
  expect(projection.apply(data.event({
    type: 'message.part.updated',
    turnId: data.turnId,
    messageId: data.messageId,
    partId: data.partId,
    payload: { part: data.message('').parts[0] },
  }))).toEqual({ state: initial, refresh: true })
})

test('移除最后一个临时片段时同步移除synthetic消息并请求结构校准', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state('通知')
  initial.messages[0]!.kind = 'synthetic'
  projection.reset(initial)
  const result = projection.apply(data.event({
    type: 'message.part.removed',
    turnId: data.turnId,
    messageId: data.messageId,
    partId: data.partId,
    payload: {},
  }))
  expect(result.refresh).toBe(true)
  expect(result.state?.messages).toEqual([])
  expect(initial.messages).toHaveLength(1)
})

test('终态等结构事实仅请求校准，未完成查询的相同事件仍可重投', () => {
  const data = fixture()
  const projection = ThreadProjection.create()
  const initial = data.state()
  projection.reset(initial)
  const event = data.event({ type: 'turn.completed', turnId: data.turnId, payload: {} })
  expect(projection.apply(event)).toEqual({ state: initial, refresh: true })
  expect(projection.apply(event)).toEqual({ state: initial, refresh: true })
  expect(initial.runtime.status).toBe('running')
  expect(projection.apply(data.event({ type: 'thread.deleted', payload: { workspaceId: 'project' } }))).toEqual({ state: undefined, refresh: true })
  expect(projection.getSnapshot()).toBeUndefined()
})
