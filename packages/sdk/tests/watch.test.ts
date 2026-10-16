import type { ThreadState } from '@elmino/thread'
import type { Client } from '../src/client/client'
import type { RuntimeEventSubscribeHandlers } from '../src/client/types'
import { createId } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import { createRuntimeEvent } from '@elmino/thread/events'
import { expect, test, vi } from 'vitest'
import { watchThread } from '../src/thread/watch'

/** 完整线程与流式事件共用同一组领域身份，不使用网络或模型 */
function fixture() {
  const target = { agentId: 'writer', workspaceId: 'project', threadId: createId('thread') }
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const now = '2026-10-16T00:00:00.000Z'
  const usage = { input: 0, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0, estimated: 0, total: 0, cacheHitRate: 0 }
  const state = (text: string): ThreadState => ({
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
  const get = vi.fn<() => Promise<ThreadState>>().mockResolvedValue(state(''))
  const client = { rpc: { thread: { get } } } as unknown as Pick<Client, 'rpc'>
  let handlers!: RuntimeEventSubscribeHandlers
  const stop = vi.fn()
  const subscribe: Client['subscribe'] = (_scope, value) => {
    handlers = value
    return stop
  }
  const event = (text: string) => createRuntimeEvent({ type: 'message.part.delta', threadId: target.threadId, turnId, messageId, partId, payload: { delta: { text } } })
  const update = (text: string) => createRuntimeEvent({ type: 'message.updated', threadId: target.threadId, turnId, messageId, payload: { message: state(text).messages[0] } })
  return { target, turnId, state, get, client, subscribe, stop, event, update, handlers: () => handlers }
}

test('连接后读取一次快照，逐字事件本地投影，终态再次读取权威状态', async () => {
  const data = fixture()
  const listener = vi.fn()
  const stop = watchThread(data.client, data.subscribe, data.target, listener)
  await data.handlers().onReset?.()
  await data.handlers().onConnected?.()
  expect(data.get).toHaveBeenCalledTimes(1)
  await data.handlers().onEvent(data.update(''))
  const delta = data.event('A')
  await data.handlers().onEvent(delta)
  await data.handlers().onEvent(delta)
  await data.handlers().onEvent(data.event('B'))
  expect(data.get).toHaveBeenCalledTimes(1)
  expect(listener.mock.calls.at(-1)?.[0].messages[0].parts[0].text).toBe('AB')
  const final = data.state('AB')
  final.turns[0]!.status = 'completed'
  final.runtime.status = 'completed'
  data.get.mockResolvedValue(final)
  await data.handlers().onEvent(createRuntimeEvent({ type: 'turn.completed', threadId: data.target.threadId, turnId: data.turnId, payload: {} }))
  expect(data.get).toHaveBeenCalledTimes(2)
  expect(listener.mock.calls.at(-1)?.[0].runtime.status).toBe('completed')
  stop()
  expect(data.stop).toHaveBeenCalledTimes(1)
})

test('reset 快照不充当无偏移 delta 锚点，相同快照不重复通知', async () => {
  const data = fixture()
  data.get.mockResolvedValue(data.state('ABC'))
  const listener = vi.fn()
  watchThread(data.client, data.subscribe, data.target, listener)
  await data.handlers().onReset?.()
  await data.handlers().onConnected?.()
  await data.handlers().onEvent(data.event('B'))
  await data.handlers().onEvent(data.event('C'))
  await data.handlers().onReset?.()
  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener.mock.calls[0]![0].messages[0].parts[0].text).toBe('ABC')
  await data.handlers().onEvent(data.update('A'))
  expect(listener.mock.calls.at(-1)?.[0].messages[0].parts[0].text).toBe('ABC')
  await data.handlers().onEvent(data.event('B'))
  await data.handlers().onEvent(data.event('C'))
  await data.handlers().onEvent(data.update('ABCD'))
  await data.handlers().onEvent(data.event('E'))
  expect(listener.mock.calls.at(-1)?.[0].messages[0].parts[0].text).toBe('ABCDE')
})

test('取消观察后不投影迟到快照，不继续发送查询或事件', async () => {
  const data = fixture()
  const gate = Promise.withResolvers<ThreadState>()
  data.get.mockReturnValue(gate.promise)
  const listener = vi.fn()
  const controller = new AbortController()
  watchThread(data.client, data.subscribe, data.target, listener, { signal: controller.signal })
  const pending = data.handlers().onConnected?.()
  controller.abort()
  gate.resolve(data.state('迟到'))
  await pending
  await data.handlers().onEvent(data.update('释放之后'))
  expect(listener).not.toHaveBeenCalled()
  expect(data.get).toHaveBeenCalledTimes(1)
  expect(data.stop).toHaveBeenCalledTimes(1)
})

test('同一毫秒的旧运行消息不能把已完成消息和工具状态回退', async () => {
  const data = fixture()
  const final = data.state('完整回复')
  final.messages[0]!.status = 'completed'
  final.messages[0]!.parts[0]!.status = 'completed'
  data.get.mockResolvedValue(final)
  const listener = vi.fn()
  const stop = watchThread(data.client, data.subscribe, data.target, listener)
  await data.handlers().onReset?.()
  await data.handlers().onEvent(data.update('完整回复'))
  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener.mock.calls[0]![0].messages[0].status).toBe('completed')
  expect(listener.mock.calls[0]![0].messages[0].parts[0].status).toBe('completed')
  stop()
})

test('状态回调失败后相同权威快照仍会重新投影，不提前确认未展示状态', async () => {
  const data = fixture()
  const error = new Error('页面状态投影失败')
  const listener = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
  const stop = watchThread(data.client, data.subscribe, data.target, listener)
  await expect(data.handlers().onReset?.()).rejects.toBe(error)
  await data.handlers().onReset?.()
  expect(listener).toHaveBeenCalledTimes(2)
  stop()
})
