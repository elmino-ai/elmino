import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { RuntimeEventSubscribeHandlers } from '../src/client/types'
import type { ClientInteraction } from '../src/run/types'
import { createId } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import { createRuntimeEvent } from '@elmino/thread/events'
import { ORPCError } from '@orpc/client'
import { expect, test, vi } from 'vitest'
import { ThreadClient } from '../src/thread/thread'

/**
 * 创建可控制接纳响应、读取结果和事件交付顺序的会话，不启动服务端
 */
function fixture() {
  // 同一会话的快照和事件固定所有身份，只有网络交付顺序由测试控制
  const target = { agentId: 'writer', workspaceId: 'project', threadId: createId('thread') }
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const now = '2026-10-16T00:00:00.000Z'
  const usage = { input: 0, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0, estimated: 0, total: 0, cacheHitRate: 0 }
  /** 权威快照独立构造，不与投影共享可变消息 */
  const state = (text = ''): ThreadState => ({
    ...target,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    pinned: false,
    unreadAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    lastInteractionAt: now,
    messages: [{
      id: messageId,
      threadId: target.threadId,
      turnId,
      role: 'assistant',
      kind: 'normal',
      status: 'streaming',
      createdAt: now,
      updatedAt: now,
      metadata: {},
      parts: [{ id: partId, messageId, threadId: target.threadId, turnId, seq: 1, status: 'running', type: 'text', text, createdAt: now, updatedAt: now }],
    }],
    turns: [{ id: turnId, agentId: target.agentId, status: 'running' }],
    children: [],
    extensions: {},
    settings: { ...DEFAULT_THREAD_SETTINGS },
    runtime: { agentId: target.agentId, turnId, status: 'running', approvalMode: 'request', usage, taskUsage: usage },
  })
  // 各观察者有自己的回调；这里保留交付次序，使运行观察先退出的路径可被确定性复现
  const active = new Set<RuntimeEventSubscribeHandlers>()
  const connections: RuntimeEventSubscribeHandlers[] = []
  const get = vi.fn<() => Promise<ThreadState>>().mockImplementation(() => Promise.resolve(state()))
  const create = vi.fn<() => Promise<ThreadState>>().mockImplementation(() => Promise.resolve(state()))
  const resume = vi.fn<() => Promise<ThreadState>>().mockImplementation(() => Promise.resolve(state()))
  /** 记录每个观察者实际归还连接引用的次数，验证信号和手动释放的幂等性 */
  const releaseConnection = vi.fn((handlers: RuntimeEventSubscribeHandlers) => {
    active.delete(handlers)
  })
  const client = {
    rpc: { thread: { get }, turn: { create, resume } },
    /** 登记一个本地观察者，退出不会移除其他观察者 */
    subscribe(_scope: unknown, handlers: RuntimeEventSubscribeHandlers) {
      active.add(handlers)
      connections.push(handlers)
      return () => releaseConnection(handlers)
    },
  } as unknown as Parameters<typeof ThreadClient.create>[0]
  const thread = ThreadClient.create(client, target)
  /** 按连接登记顺序交付同一条事实，退订的运行不再参与后续事件 */
  const emit = async (event: RuntimeEvent) => {
    for (const handlers of [...active])
      await handlers.onEvent(event)
  }
  /** 真实连接重置带同一身份，本地观察者校准不带身份 */
  const reset = (index: number, connection?: object) => (
    connections[index]!.onReset as ((connection?: object) => void | Promise<void>) | undefined
  )?.(connection)
  /** 完整事件负责当前连接的正文锚点 */
  const update = () => createRuntimeEvent({
    type: 'message.updated',
    threadId: target.threadId,
    turnId,
    messageId,
    payload: { message: state().messages[0] },
  })
  /** 正文增量不携带字符偏移，必须沿用完整事件锚点 */
  const delta = (text: string) => createRuntimeEvent({
    type: 'message.part.delta',
    threadId: target.threadId,
    turnId,
    messageId,
    partId,
    payload: { delta: { text } },
  })
  return { target, turnId, thread, connections, releaseConnection, get, create, resume, state, emit, reset, update, delta }
}

test('异步watch与同步快照共享线程、连接状态和错误，重连成功清除错误', async () => {
  const data = fixture()
  const listener = vi.fn()
  const onError = vi.fn()
  const release = data.thread.watch(listener, { onError })
  expect(data.thread.getSnapshot()).toEqual({ status: 'connecting', error: undefined })
  try {
    await data.connections[0]!.onConnected?.()
    expect(data.thread.getSnapshot().status).toBe('connected')
    expect(data.thread.getSnapshot().thread).toBe(listener.mock.calls.at(-1)?.[0])
    await data.emit(data.update())
    await data.emit(data.delta('实时正文'))
    expect(data.thread.getSnapshot().thread).toBe(listener.mock.calls.at(-1)?.[0])
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: '实时正文' })
    const failure = new Error('连接断开')
    await data.connections[0]!.onError?.(failure)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(data.thread.getSnapshot()).toMatchObject({ status: 'reconnecting', error: failure })
    // 本地校准保持已经获知的正文，连接重新可用时同步移除旧错误
    await data.reset(0)
    await data.connections[0]!.onConnected?.()
    expect(data.thread.getSnapshot().status).toBe('connected')
    expect(data.thread.getSnapshot().error).toBeUndefined()
    expect(data.thread.getSnapshot().thread).toBe(listener.mock.calls.at(-1)?.[0])
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: '实时正文' })
  }
  finally {
    release()
  }
  expect(data.thread.getSnapshot().status).toBe('closed')
})

test('多个watch与同步subscribe各自持有引用，最后一个退出才标记closed', async () => {
  const data = fixture()
  const first = data.thread.watch(() => undefined)
  const second = data.thread.watch(() => undefined)
  const subscribed = data.thread.subscribe(() => undefined)
  for (const handlers of data.connections)
    await handlers.onConnected?.()
  try {
    first()
    first()
    expect(data.thread.getSnapshot().status).toBe('connected')
    subscribed()
    expect(data.thread.getSnapshot().status).toBe('connected')
    expect(data.releaseConnection).toHaveBeenCalledTimes(2)
    second()
    second()
    expect(data.releaseConnection).toHaveBeenCalledTimes(3)
    expect(data.thread.getSnapshot().status).toBe('closed')
  }
  finally {
    first()
    second()
    subscribed()
  }
})

test('watch信号取消与手动释放只归还一次引用，运行观察仍能继续消费输出', async () => {
  const data = fixture()
  const controller = new AbortController()
  const listener = vi.fn()
  const release = data.thread.watch(listener, { signal: controller.signal })
  await data.connections[0]!.onConnected?.()
  const onText = vi.fn()
  const run = data.thread.start('继续', { turnId: data.turnId, onText })
  await data.connections[1]!.onConnected?.()
  await run.accepted
  try {
    await data.emit(data.update())
    await data.emit(data.delta('A'))
    const delivered = listener.mock.calls.length
    controller.abort()
    release()
    release()
    expect(data.releaseConnection).toHaveBeenCalledTimes(1)
    expect(data.releaseConnection).toHaveBeenCalledWith(data.connections[0])
    await data.emit(data.delta('B'))
    expect(listener).toHaveBeenCalledTimes(delivered)
    expect(onText.mock.calls.flat().join('')).toBe('AB')
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    release()
    run.detach()
    await run.completed.catch(() => undefined)
  }
  expect(data.releaseConnection).toHaveBeenCalledTimes(2)
})

test('运行detach后会话订阅仍沿同一锚点更新正文', async () => {
  const data = fixture()
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const run = data.thread.start('继续', { turnId: data.turnId })
  await data.connections[1]!.onConnected?.()
  await run.accepted
  try {
    await data.emit(data.update())
    await data.emit(data.delta('A'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'A' })
    run.detach()
    await expect(run.completed).rejects.toMatchObject({ name: 'AbortError' })
    await data.emit(data.delta('B'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    run.detach()
    release()
  }
})

test('运行中普通get读取不清除正在消费的正文锚点', async () => {
  const data = fixture()
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  try {
    await data.emit(data.update())
    await data.emit(data.delta('A'))
    data.get.mockResolvedValue(data.state('A'))
    await data.thread.get()
    await data.emit(data.delta('B'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    release()
  }
})

test('新attach观察者的本地校准不能清除既有会话观察的正文锚点', async () => {
  const data = fixture()
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  await data.emit(data.update())
  await data.emit(data.delta('A'))
  data.get.mockResolvedValue(data.state('A'))
  const run = data.thread.attach(data.turnId)
  try {
    // 已连接通道给新观察者发送本地reset，旧观察者的连接与锚点一直有效
    await data.reset(1)
    await data.connections[1]!.onConnected?.()
    await run.accepted
    await data.emit(data.delta('B'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})

test('创建接纳响应晚于完整事件时不丢失后续正文', async () => {
  const data = fixture()
  const acceptance = Promise.withResolvers<ThreadState>()
  data.create.mockReturnValue(acceptance.promise)
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const run = data.thread.start('继续', { turnId: data.turnId })
  await data.connections[1]!.onConnected?.()
  await vi.waitFor(() => expect(data.create).toHaveBeenCalledOnce())
  try {
    await data.emit(data.update())
    await data.emit(data.delta('A'))
    // HTTP响应在SSE之后返回，它只是完整快照，不是新连接边界
    acceptance.resolve(data.state())
    await run.accepted
    await data.emit(data.delta('B'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})

test('两个观察者重连校准先后返回时不清除新连接已建立的正文锚点', async () => {
  const data = fixture()
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const run = data.thread.start('继续', { turnId: data.turnId })
  await data.connections[1]!.onConnected?.()
  await run.accepted
  const late = Promise.withResolvers<ThreadState>()
  data.get.mockReturnValueOnce(late.promise).mockResolvedValue(data.state('A'))
  const connection = {}
  const pending = data.reset(0, connection)
  try {
    await data.reset(1, connection)
    // 运行观察者已完成重连校准，会话观察者还在等待同一轮校准读取
    await data.connections[1]!.onEvent(data.update())
    await data.connections[1]!.onEvent(data.delta('A'))
    late.resolve(data.state('A'))
    await pending
    await data.emit(data.delta('B'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: 'AB' })
  }
  finally {
    late.resolve(data.state())
    await pending
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})

test('恢复后重连读到运行事实即可继续输出，不依赖丢失的turn.started事件', async () => {
  const data = fixture()
  const interruptId = createId('interrupt')
  const interaction: ClientInteraction = {
    ...data.target,
    turnId: data.turnId,
    interruptId,
    interrupt: {
      id: interruptId,
      turnId: data.turnId,
      kind: 'interaction',
      interaction: 'review',
      status: 'pending',
      reason: '等待确认',
      payload: {},
      createdAt: '2026-10-16T00:00:00.000Z',
      resumableWith: ['interaction'],
    },
  }
  const baseline = data.state('审批前正文')
  baseline.turns[0]!.status = 'interrupted'
  baseline.runtime.status = 'interrupted'
  baseline.runtime.interrupt = interaction.interrupt
  const running = data.state('审批前正文')
  data.get.mockResolvedValueOnce(baseline).mockResolvedValue(running)
  data.resume.mockResolvedValue(running)
  const onText = vi.fn()
  const run = data.thread.resume(interaction, {}, { onText })
  await data.connections[0]!.onConnected?.()
  await run.accepted
  try {
    await data.reset(0, {})
    // 模拟重连窗口丢弃turn.started，仅收到此后的完整消息与增量
    const message = data.state().messages[0]!
    message.id = createId('msg')
    message.parts = [{ ...message.parts[0]!, id: createId('part'), messageId: message.id }]
    await data.emit(createRuntimeEvent({
      type: 'message.updated',
      threadId: data.target.threadId,
      turnId: data.turnId,
      messageId: message.id,
      payload: { message },
    }))
    await data.emit(createRuntimeEvent({
      type: 'message.part.delta',
      threadId: data.target.threadId,
      turnId: data.turnId,
      messageId: message.id,
      partId: message.parts[0]!.id,
      payload: { delta: { text: '恢复后正文' } },
    }))
    expect(onText.mock.calls.flat().join('')).toBe('恢复后正文')
  }
  finally {
    run.detach()
    await run.completed.catch(() => undefined)
  }
})

test('删除线程清空公开快照，删除前启动的迟到读取不能复活它', async () => {
  const data = fixture()
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const late = Promise.withResolvers<ThreadState>()
  data.get.mockReturnValueOnce(late.promise)
  const pending = data.thread.get().catch(() => undefined)
  data.get.mockRejectedValueOnce(new ORPCError('NOT_FOUND'))
  try {
    await data.emit(createRuntimeEvent({
      type: 'thread.deleted',
      threadId: data.target.threadId,
      payload: { workspaceId: data.target.workspaceId },
    }))
    expect(data.thread.getSnapshot().thread).toBeUndefined()
    late.resolve(data.state('删除前的旧快照'))
    await pending
    expect(data.thread.getSnapshot().thread).toBeUndefined()
  }
  finally {
    late.resolve(data.state())
    await pending
    release()
  }
})

test('删除事件先于创建接纳响应时，迟到接纳快照不能复活线程', async () => {
  const data = fixture()
  const acceptance = Promise.withResolvers<ThreadState>()
  data.create.mockReturnValue(acceptance.promise)
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const run = data.thread.start('继续', { turnId: data.turnId })
  await data.connections[1]!.onConnected?.()
  await vi.waitFor(() => expect(data.create).toHaveBeenCalledOnce())
  data.get.mockRejectedValueOnce(new ORPCError('NOT_FOUND'))
  try {
    await data.emit(createRuntimeEvent({
      type: 'thread.deleted',
      threadId: data.target.threadId,
      payload: { workspaceId: data.target.workspaceId },
    }))
    expect(data.thread.getSnapshot().thread).toBeUndefined()
    acceptance.resolve(data.state('删除前已接纳的旧快照'))
    await run.accepted.catch(() => undefined)
    expect(data.thread.getSnapshot().thread).toBeUndefined()
  }
  finally {
    acceptance.resolve(data.state())
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})

test('首次未创建快照的迟到404不能清除已经接纳的新线程', async () => {
  const data = fixture()
  const initialRead = Promise.withResolvers<ThreadState>()
  data.get.mockReturnValueOnce(initialRead.promise)
  const release = data.thread.subscribe(() => undefined)
  const pending = Promise.resolve(data.connections[0]!.onConnected?.()).catch(error => error)
  const run = data.thread.start('首次运行', { turnId: data.turnId })
  await data.connections[1]!.onConnected?.()
  await run.accepted
  try {
    initialRead.reject(new ORPCError('NOT_FOUND'))
    expect(await pending).toBeUndefined()
    expect(data.thread.getSnapshot().thread?.threadId).toBe(data.target.threadId)
    await data.emit(data.update())
    await data.emit(data.delta('首轮输出'))
    expect(data.thread.getSnapshot().thread?.messages[0]?.parts[0]).toMatchObject({ text: '首轮输出' })
  }
  finally {
    initialRead.resolve(data.state())
    await pending
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})

test('detach之后忽略取消信号而迟到的读取不能继续写入会话', async () => {
  const data = fixture()
  const late = Promise.withResolvers<ThreadState>()
  data.get.mockReturnValueOnce(late.promise)
  const run = data.thread.attach(data.turnId)
  await data.connections[0]!.onConnected?.()
  await vi.waitFor(() => expect(data.get).toHaveBeenCalledOnce())
  run.detach()
  await expect(run.completed).rejects.toMatchObject({ name: 'AbortError' })
  late.resolve(data.state('已退出观察的迟到内容'))
  // 只等待迟到读取自身结束，不启动另一个请求或靠时间推测写入是否完成
  await late.promise
  await Promise.resolve()
  await Promise.resolve()
  expect(data.thread.getSnapshot().thread).toBeUndefined()
})

test('慢输出之后才执行的校准投影不能复活期间已删除的线程', async () => {
  const data = fixture()
  data.get.mockResolvedValue(data.state('A'))
  const release = data.thread.subscribe(() => undefined)
  await data.connections[0]!.onConnected?.()
  const output = Promise.withResolvers<void>()
  const onText = vi.fn(() => output.promise)
  const run = data.thread.attach(data.turnId, { onText })
  await data.connections[1]!.onConnected?.()
  await vi.waitFor(() => expect(onText).toHaveBeenCalledOnce())
  // attach主流程正在等待输出，此时重连可以完成读取但仍须排队交付其快照
  const pending = Promise.resolve(data.reset(1, {})).catch(error => error)
  await vi.waitFor(() => expect(data.get).toHaveBeenCalledTimes(3))
  data.get.mockRejectedValueOnce(new ORPCError('NOT_FOUND'))
  try {
    await data.emit(createRuntimeEvent({
      type: 'thread.deleted',
      threadId: data.target.threadId,
      payload: { workspaceId: data.target.workspaceId },
    }))
    expect(data.thread.getSnapshot().thread).toBeUndefined()
    output.resolve()
    await pending
    await run.accepted.catch(() => undefined)
    expect(data.thread.getSnapshot().thread).toBeUndefined()
  }
  finally {
    output.resolve()
    await pending
    run.detach()
    await run.completed.catch(() => undefined)
    release()
  }
})
