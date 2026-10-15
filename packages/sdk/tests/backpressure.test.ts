import type { RuntimeEvent } from '@elmino/thread/events'
import { expect, onTestFinished, test } from 'vitest'
import { Client } from '../src/index'
import { createEvent, frame, openStream, scope, streamId } from './support/stream'

test('reset 和事件 handler 串行施加背压，不把整条流读入 Promise 队列', async () => {
  const resetStarted = Promise.withResolvers<void>()
  const eventStarted = Promise.withResolvers<void>()
  const resetGate = Promise.withResolvers<void>()
  const eventGate = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const frames = [
    frame({ type: 'stream.reset' }, `${streamId}:0`),
    ...Array.from({ length: 50 }, (_, index) => frame(createEvent(index + 1), `${streamId}:${index + 1}`)),
  ]
  let frameIndex = 0
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      const value = frames[frameIndex++]
      if (value)
        controller.enqueue(new TextEncoder().encode(value))
    },
    cancel() {
      cancelled.resolve()
    },
  })
  const client = Client.create({
    baseUrl: 'https://service.example',
    fetch: () => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
  })
  const received: string[] = []
  const unsubscribe = client.subscribe(scope, {
    onReset() {
      resetStarted.resolve()
      return resetGate.promise
    },
    async onEvent(event) {
      if (received.length === 0) {
        eventStarted.resolve()
        await eventGate.promise
      }
      received.push(event.id)
      if (received.length === 50)
        completed.resolve()
    },
    onError: error => completed.reject(error),
  })
  onTestFinished(() => {
    resetGate.resolve()
    eventGate.resolve()
    unsubscribe()
  })

  await resetStarted.promise
  // 原始正文、解码管线和当前 read 可各持有单块，但不能按事件数持续预读
  expect(pulls).toBeLessThanOrEqual(4)
  const blockedPulls = pulls
  for (let index = 0; index < 100; index++)
    await Promise.resolve()
  expect(pulls).toBe(blockedPulls)
  expect(received).toEqual([])
  resetGate.resolve()
  await eventStarted.promise
  expect(pulls).toBeLessThanOrEqual(5)
  expect(received).toEqual([])
  eventGate.resolve()
  await completed.promise
  expect(received).toEqual(Array.from({ length: 50 }, (_, index) => createEvent(index + 1).id))
  unsubscribe()
  await cancelled.promise
})

test('取消等待中的 handler 后释放 reader，不消费同一块中剩余事实', async () => {
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const first = createEvent(1)
  const stream = openStream([frame(first, `${streamId}:1`), frame(createEvent(2), `${streamId}:2`)])
  const client = Client.create({ baseUrl: 'https://service.example', fetch: () => Promise.resolve(stream.response) })
  const received: string[] = []
  const unsubscribe = client.subscribe(scope, {
    async onEvent(event) {
      started.resolve()
      await gate.promise
      received.push(event.id)
    },
  })
  onTestFinished(unsubscribe)

  await started.promise
  unsubscribe()
  await stream.cancelled
  gate.resolve()
  await gate.promise
  expect(received).toEqual([first.id])
})

test('单个超过一 MiB 的事件通过实际 SSE 解码保留全部正文', async () => {
  const text = `${'x'.repeat(1_100_000)}-完整结尾`
  const event: RuntimeEvent = {
    ...createEvent(1),
    type: 'message.part.delta',
    messageId: 'msg_55555555-5555-4555-8555-555555555555',
    partId: 'part_66666666-6666-4666-8666-666666666666',
    payload: { delta: { text } },
  }
  const received = Promise.withResolvers<RuntimeEvent>()
  const stream = openStream([frame(event, `${streamId}:1`)])
  const client = Client.create({ baseUrl: 'https://service.example', fetch: () => Promise.resolve(stream.response) })
  const unsubscribe = client.subscribe(scope, { onEvent: received.resolve, onError: received.reject })
  onTestFinished(unsubscribe)

  expect((await received.promise).payload).toEqual({ delta: { text } })
  unsubscribe()
  await stream.cancelled
})
