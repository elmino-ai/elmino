import type { RuntimeEvent } from '@elmino/thread/events'
import { createId } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread/events'
import { describe, expect, test } from 'vitest'
import {
  isRuntimeEvent,
  isRuntimeStreamMessage,
  parseRuntimeEventJson,
  parseRuntimeStreamMessageJson,
  RuntimeEventSchema,
  serializeRuntimeEvent,
} from '../src/index'

/** -------------------- 测试 -------------------- */
describe('跨端运行事件', () => {
  test('领域工厂创建的事件可在 JSON 边界往返，字段不重新定义', () => {
    const event = createRuntimeEvent({
      threadId: createId('thread'),
      turnId: createId('turn'),
      type: 'turn.completed',
      payload: { unreadAt: new Date().toISOString(), message: undefined },
    })
    const text = serializeRuntimeEvent(event)
    expect(parseRuntimeEventJson(text)).toEqual(JSON.parse(text))
    expect(parseRuntimeEventJson(text)?.id).toBe(event.id)
  })

  test('API 与 SDK 对错误载荷使用同一判定，不推进无法消费的消息', () => {
    const value = createRuntimeEvent({ threadId: createId('thread'), type: 'message.updated', payload: {} })
    expect(isRuntimeEvent(value)).toBe(false)
    expect(isRuntimeStreamMessage(value)).toBe(false)
    expect(parseRuntimeStreamMessageJson(JSON.stringify(value))).toBeUndefined()
    expect(() => serializeRuntimeEvent(value)).toThrow('传输校验')
    expect(RuntimeEventSchema.safeParse(value).success).toBe(false)
  })

  test.each(['stream.connected', 'stream.reset'])('控制消息 %s 与事实事件分开解析', (type) => {
    const message = { type }
    expect(isRuntimeStreamMessage(message)).toBe(true)
    expect(isRuntimeEvent(message)).toBe(false)
    expect(parseRuntimeStreamMessageJson(JSON.stringify(message))).toEqual(message)
    expect(parseRuntimeEventJson(JSON.stringify(message))).toBeUndefined()
  })

  test('拒绝未知控制、伪造 ID、无效日期与缺少 payload', () => {
    const event = createRuntimeEvent({
      threadId: createId('thread'),
      turnId: createId('turn'),
      type: 'turn.completed',
      payload: {},
    })
    for (const value of [
      { type: 'stream.unknown' },
      { type: 'stream.reset', payload: '伪造载荷' },
      { ...event, id: 'event_old' },
      { ...event, threadId: 'thread_old' },
      { ...event, createdAt: '2026-02-31T00:00:00Z' },
      { ...event, payload: undefined },
      { ...event, type: 'unknown' },
    ]) {
      expect(isRuntimeStreamMessage(value)).toBe(false)
      expect(parseRuntimeEventJson(JSON.stringify(value))).toBeUndefined()
    }
    expect(parseRuntimeEventJson('{')).toBeUndefined()
  })

  test('派生片段 ID 必须属于事件中的消息，Provider 原生 ID 只出现在后缀', () => {
    const messageId = createId('msg')
    const event = createRuntimeEvent({
      threadId: createId('thread'),
      turnId: createId('turn'),
      messageId,
      type: 'message.part.delta',
      partId: `${messageId}:tool:call_provider`,
      toolCallId: createId('tool'),
      payload: { delta: { output: '输出', offset: 0 } },
    })
    expect(isRuntimeEvent(event)).toBe(true)
    expect(isRuntimeEvent({ ...event, partId: `${createId('msg')}:reasoning` })).toBe(false)
    expect(isRuntimeEvent({ ...event, toolCallId: 'call_provider' })).toBe(false)
    expect(isRuntimeEvent({ ...event, payload: { delta: { output: '输出', offset: -1 } } })).toBe(false)
    expect(isRuntimeEvent({ ...event, payload: { delta: { text: '文本', output: '输出', offset: 0 } } })).toBe(false)
  })

  test('人工交互中断核对 ID、Turn、时间与未读信息', () => {
    const turnId = createId('turn')
    const interruptId = createId('interrupt')
    const createdAt = new Date().toISOString()
    const threadId = createId('thread')
    const event = createRuntimeEvent({
      threadId,
      turnId,
      interruptId,
      type: 'turn.interrupted',
      payload: {
        id: interruptId,
        turnId,
        kind: 'interaction',
        interaction: 'ask',
        status: 'pending',
        reason: '等待回答',
        payload: {},
        resumableWith: ['interaction'],
        createdAt,
        unreadAt: createdAt,
      },
    })
    expect(isRuntimeEvent(event)).toBe(true)
    expect(isRuntimeEvent({ ...event, interruptId: createId('interrupt') })).toBe(false)
    expect(isRuntimeEvent({ ...event, payload: { ...event.payload, kind: 'system' } })).toBe(false)
    expect(isRuntimeEvent({ ...event, payload: { ...event.payload, createdAt: 'yesterday' } })).toBe(false)
    expect(isRuntimeEvent({ ...event, payload: { ...event.payload, payload: undefined } })).toBe(false)
    for (const resumableWith of [[], ['message']]) {
      const invalid = { ...event, payload: { ...event.payload, resumableWith } }
      expect(isRuntimeEvent(invalid)).toBe(false)
      expect(isRuntimeStreamMessage(invalid)).toBe(false)
      expect(() => serializeRuntimeEvent(invalid)).toThrow(TypeError)
    }
  })

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    () => '不可丢弃',
    Symbol('不可丢弃'),
    new Map(),
    new Date(),
    [undefined],
    Array.from({ length: 1 }).fill(undefined),
  ])('拒绝 JSON 无法无损表示的载荷 %s', (value) => {
    const event = createRuntimeEvent({
      threadId: createId('thread'),
      turnId: createId('turn'),
      type: 'turn.completed',
      payload: { extra: value },
    })
    expect(() => serializeRuntimeEvent(event)).toThrow(TypeError)
  })

  test('拒绝循环引用，允许重复引用的普通对象', () => {
    const payload: Record<string, unknown> = {}
    payload.self = payload
    const event: RuntimeEvent = createRuntimeEvent({
      threadId: createId('thread'),
      turnId: createId('turn'),
      type: 'turn.completed',
      payload,
    })
    expect(() => serializeRuntimeEvent(event)).toThrow(TypeError)
    const shared = { value: '可复用' }
    expect(() => serializeRuntimeEvent({ ...event, payload: { a: shared, b: shared } })).not.toThrow()
  })
})
