import type { RuntimeEventHubOptions } from '../src/event/hub'
import { Buffer } from 'node:buffer'
import { parseRuntimeEventCursor, serializeRuntimeEvent } from '@elmino/protocol'
import { createRuntimeEvent } from '@elmino/thread/events'
import { expect, onTestFinished, test, vi } from 'vitest'
import { RuntimeEventHub } from '../src/event/hub'

/** 当前服务进程的稳定测试流身份 */
const streamId = 'stream_11111111-1111-4111-8111-111111111111'
/** 用于线程过滤的两个独立领域身份 */
const threadId = 'thread_11111111-1111-4111-8111-111111111111'
const otherThreadId = 'thread_22222222-2222-4222-8222-222222222222'

/** 构造可通过真实传输协议的文本增量 */
function event(text: string, targetThreadId = threadId) {
  return createRuntimeEvent({
    type: 'message.part.delta',
    threadId: targetThreadId,
    turnId: 'turn_22222222-2222-4222-8222-222222222222',
    messageId: 'msg_33333333-3333-4333-8333-333333333333',
    partId: 'part_44444444-4444-4444-8444-444444444444',
    createdAt: '2026-07-14T00:00:00.000Z',
    payload: { delta: { text } },
  })
}

/** 测试拥有 Hub 的释放权，不遗留等待中的订阅 */
function createHub(options: RuntimeEventHubOptions = {}) {
  const hub = RuntimeEventHub.create({ streamId, ...options })
  onTestFinished(() => hub.close())
  return hub
}

test('合法游标先重放领域事件再确认连接，随后无重复进入实时事件', async () => {
  const hub = createHub()
  const first = event('first')
  const second = event('second')
  hub.publish(first)
  hub.publish(second)
  const iterator = hub.subscribe(`${streamId}:0`)

  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:1`, message: JSON.parse(JSON.stringify(first)) } })
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: JSON.parse(JSON.stringify(second)) } })
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { cursor: `${streamId}:2`, message: { type: 'stream.connected' } } })
  const pending = iterator.next()
  hub.publish(event('live'))
  await expect(pending).resolves.toMatchObject({ value: { cursor: `${streamId}:3`, message: { payload: { delta: { text: 'live' } } } } })
})

test('重放期间新发布的事件在 connected 之后交付，不跨越确认游标', async () => {
  const hub = createHub()
  hub.publish(event('retained'))
  const iterator = hub.subscribe(`${streamId}:0`)
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:1` } })
  hub.publish(event('published during replay'))
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: { cursor: `${streamId}:1`, message: { type: 'stream.connected' } },
  })
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: { payload: { delta: { text: 'published during replay' } } } } })
})

test.each([
  undefined,
  'invalid',
  'stream_22222222-2222-4222-8222-222222222222:1',
  `${streamId}:2`,
  `${streamId}:-1`,
  `${streamId}:01`,
])('无游标或不可用游标 %s 从当前全局位置重建快照', async (cursor) => {
  const hub = createHub()
  hub.publish(event('historical'))
  const iterator = hub.subscribe(cursor)
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { cursor: `${streamId}:1`, message: { type: 'stream.reset' } } })
  hub.publish(event('after reset'))
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: { payload: { delta: { text: 'after reset' } } } } })
})

test('新服务进程生成新 epoch，旧游标不能误入新流', async () => {
  const first = RuntimeEventHub.create()
  const second = RuntimeEventHub.create()
  onTestFinished(() => {
    first.close()
    second.close()
  })
  const initial = await first.subscribe().next()
  const cursor = initial.value!.cursor
  const resumed = await second.subscribe(cursor).next()

  expect(parseRuntimeEventCursor(resumed.value!.cursor)?.streamId)
    .not
    .toBe(parseRuntimeEventCursor(cursor)?.streamId)
  expect(resumed.value!.message).toEqual({ type: 'stream.reset' })
})

test.each([0, -1])('重放预算按 UTF-8 JSON 字节计算，边界偏移 %s 字节', async (offset) => {
  const first = event('汉'.repeat(1_000))
  const second = event('字'.repeat(1_000))
  const size = Buffer.byteLength(serializeRuntimeEvent(first))
  expect(size).toBeGreaterThan(serializeRuntimeEvent(first).length)
  const hub = createHub({ maxBytes: size * 2 + offset })
  hub.publish(first)
  hub.publish(second)
  const iterator = hub.subscribe(`${streamId}:0`)

  if (offset === 0) {
    await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:1`, message: JSON.parse(JSON.stringify(first)) } })
    await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: JSON.parse(JSON.stringify(second)) } })
  }
  else {
    await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: { type: 'stream.reset' } } })
    const retained = hub.subscribe(`${streamId}:1`)
    await expect(retained.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:2`, message: JSON.parse(JSON.stringify(second)) } })
  }
})

test('慢订阅超出窗口明确失败，不影响持续消费的订阅', async () => {
  const hub = createHub({ maxBytes: 1_024 })
  const slow = hub.subscribe(`${streamId}:0`)
  const fast = hub.subscribe(`${streamId}:0`)
  await slow.next()
  await fast.next()
  for (let index = 0; index < 30; index++) {
    hub.publish(event(`queued_${index}`))
    await expect(fast.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:${index + 1}` } })
  }
  await expect(slow.next()).rejects.toThrow('运行事件订阅落后于回放窗口')
  hub.publish(event('still connected'))
  await expect(fast.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:31` } })
})

test('重放过程中被淘汰的帧也明确失败，不用 connected 掩盖缺口', async () => {
  const sample = event('sample')
  const hub = createHub({ maxBytes: Buffer.byteLength(serializeRuntimeEvent(sample)) * 2 })
  hub.publish(sample)
  hub.publish(event('second'))
  const iterator = hub.subscribe(`${streamId}:0`)
  await iterator.next()
  for (let index = 0; index < 5; index++)
    hub.publish(event('newest'))
  await expect(iterator.next()).rejects.toThrow('运行事件订阅落后于回放窗口')
})

test.each([0, 1_024])('容量 %s 不保留超大事件，已连接的订阅失败，新订阅 reset', async (maxBytes) => {
  const hub = createHub({ maxBytes })
  const iterator = hub.subscribe(`${streamId}:0`)
  await iterator.next()
  const pending = iterator.next()
  hub.publish(event('x'.repeat(4_096)))
  await expect(pending).rejects.toThrow('运行事件订阅落后于回放窗口')
  await expect(hub.subscribe(`${streamId}:0`).next()).resolves.toMatchObject({
    value: { cursor: `${streamId}:1`, message: { type: 'stream.reset' } },
  })
  await expect(hub.subscribe(`${streamId}:1`).next()).resolves.toMatchObject({
    value: { cursor: `${streamId}:1`, message: { type: 'stream.connected' } },
  })
})

test('序列化失败不消耗游标，也不污染后续重放', async () => {
  const hub = createHub()
  expect(() => hub.publish({ ...event('invalid'), payload: { invalid: Number.NaN } })).toThrow(TypeError)
  const valid = event('valid')
  hub.publish(valid)
  await expect(hub.subscribe(`${streamId}:0`).next()).resolves.toMatchObject({ value: { cursor: `${streamId}:1`, message: JSON.parse(JSON.stringify(valid)) } })
})

test('发布快照与单次 JSON 规范化一致，发布方和消费方都不能篡改其他订阅的重放', async () => {
  const hub = createHub()
  const source = event('original')
  source.interruptId = undefined
  const normalized: unknown = JSON.parse(serializeRuntimeEvent(source))
  hub.publish(source)
  source.payload.delta.text = 'changed by publisher'
  const first = await hub.subscribe(`${streamId}:0`).next()
  expect(first.value!.message).toEqual(normalized)
  expect(Object.hasOwn(first.value!.message, 'interruptId')).toBe(false)
  Object.assign(first.value!.message, { payload: { delta: { text: 'changed by consumer' } } })
  const second = await hub.subscribe(`${streamId}:0`).next()
  expect(second.value!.message).toEqual(normalized)
})

test('请求取消立即唤醒空流并释放其取消监听', async () => {
  const hub = createHub()
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const iterator = hub.subscribe(`${streamId}:0`, controller.signal)
  await iterator.next()
  const pending = iterator.next()
  controller.abort()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  expect(add).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1])
})

test('已取消的请求不会创建控制帧或注册监听', async () => {
  const hub = createHub()
  const signal = AbortSignal.abort()
  const add = vi.spyOn(signal, 'addEventListener')
  await expect(hub.subscribe(undefined, signal).next()).resolves.toEqual({ done: true, value: undefined })
  expect(add).not.toHaveBeenCalled()
})

test('close 结束所有空流等待与暂停重放，拒绝新发布，重复关闭安全', async () => {
  const hub = createHub()
  const first = hub.subscribe(`${streamId}:0`)
  const controller = new AbortController()
  const second = hub.subscribe(`${streamId}:0`, controller.signal)
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  await first.next()
  await second.next()
  const pendingFirst = first.next()
  const pendingSecond = second.next()
  hub.close()
  hub.close()
  await expect(pendingFirst).resolves.toEqual({ done: true, value: undefined })
  await expect(pendingSecond).resolves.toEqual({ done: true, value: undefined })
  expect(remove).toHaveBeenCalledOnce()
  expect(() => hub.publish(event('closed'))).toThrow('运行事件 Hub 已关闭')
  await expect(hub.subscribe().next()).resolves.toEqual({ done: true, value: undefined })

  const replayHub = createHub()
  replayHub.publish(event('first'))
  replayHub.publish(event('second'))
  const paused = replayHub.subscribe(`${streamId}:0`)
  await paused.next()
  replayHub.close()
  await expect(paused.next()).resolves.toEqual({ done: true, value: undefined })
})

test('线程过滤不输出其他线程事实，重放和实时订阅使用同一全局序号', async () => {
  const hub = createHub()
  hub.publish(event('a1'))
  hub.publish(event('b2', otherThreadId))
  hub.publish(event('a3'))
  hub.publish(event('b4', otherThreadId))
  const filter = { threadId }
  const iterator = hub.subscribe(`${streamId}:0`, undefined, filter)
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:1`, message: { threadId } } })
  filter.threadId = otherThreadId
  await expect(iterator.next()).resolves.toMatchObject({ value: { cursor: `${streamId}:3`, message: { threadId } } })
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { cursor: `${streamId}:4`, message: { type: 'stream.connected' } } })
  const pending = iterator.next()
  hub.publish(event('b5', otherThreadId))
  hub.publish(event('a6'))
  await expect(pending).resolves.toMatchObject({ value: { cursor: `${streamId}:6`, message: { threadId } } })
})

test('其他线程填满全局窗口后，过滤订阅也显式重新同步而不泄漏载荷', async () => {
  const hub = createHub({ maxBytes: 1_024 })
  const iterator = hub.subscribe(`${streamId}:0`, undefined, { threadId })
  await iterator.next()
  for (let index = 0; index < 20; index++)
    hub.publish(event('other', otherThreadId))
  await expect(iterator.next()).rejects.toThrow('运行事件订阅落后于回放窗口')
  await expect(hub.subscribe(`${streamId}:0`, undefined, { threadId }).next()).resolves.toEqual({
    done: false,
    value: { cursor: `${streamId}:20`, message: { type: 'stream.reset' } },
  })
})

test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('无效容量 %s 在接纳订阅之前拒绝', (maxBytes) => {
  expect(() => RuntimeEventHub.create({ maxBytes })).toThrow(RangeError)
})
