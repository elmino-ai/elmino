import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { Client } from '../src/index'
import { closedStream, createEvent, flushUntil, frame, openStream, scope, streamId } from './support/stream'

afterEach(() => {
  vi.useRealTimers()
})

test('只在 handler 成功后确认游标，重连保持作用域和动态鉴权', async () => {
  vi.useFakeTimers()
  const requests: Request[] = []
  const event = createEvent(1)
  const gate = Promise.withResolvers<void>()
  let token = 'first'
  const held = openStream()
  const client = Client.create({
    baseUrl: 'https://service.example/prefix',
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(requests.length === 1
        ? closedStream([frame(event, `${streamId}:1`)])
        : held.response)
    },
  })
  const onEvent = vi.fn(() => gate.promise)
  const unsubscribe = client.subscribe({ ...scope, threadId: event.threadId }, { onEvent })
  onTestFinished(unsubscribe)
  await flushUntil(() => onEvent.mock.calls.length === 1)
  expect(vi.getTimerCount()).toBe(0)
  gate.resolve()
  await flushUntil(() => vi.getTimerCount() === 1)
  token = 'second'
  vi.advanceTimersByTime(10)
  await flushUntil(() => requests.length === 2)
  expect(requests[0]?.url).toBe('https://service.example/prefix/rpc/events/subscribe')
  expect(await requests[0]?.json()).toEqual({ json: { ...scope, threadId: event.threadId } })
  expect(requests[1]?.headers.get('last-event-id')).toBe(`${streamId}:1`)
  expect(requests[1]?.headers.get('authorization')).toBe('Bearer second')
  unsubscribe()
  await held.cancelled
})

test('事件 handler 失败重试原事实且不会确认失败游标', async () => {
  vi.useFakeTimers()
  const requests: Request[] = []
  const event = createEvent(1)
  const first = openStream([frame(event, `${streamId}:1`)])
  const second = openStream([frame(event, `${streamId}:1`)])
  const failure = new Error('projection failed')
  const onEvent = vi.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined)
  const onError = vi.fn()
  const client = Client.create({
    baseUrl: 'https://service.example',
    retry: { initialDelayMs: 10 },
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(requests.length === 1 ? first.response : second.response)
    },
  })
  const unsubscribe = client.subscribe(scope, { onEvent, onError })
  onTestFinished(unsubscribe)
  await first.cancelled
  await flushUntil(() => vi.getTimerCount() === 1)
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  vi.advanceTimersByTime(10)
  await flushUntil(() => onEvent.mock.calls.length === 2)
  expect(requests[1]?.headers.get('last-event-id')).toBeNull()
  expect(onEvent.mock.calls[1]?.[0]).toEqual(event)
  unsubscribe()
  await second.cancelled
})

test('reset 失败保留旧游标，重建成功才提交新流位置', async () => {
  vi.useFakeTimers()
  const previous = `${streamId}:1`
  const next = 'stream_44444444-4444-4444-8444-444444444444:0'
  const requests: Request[] = []
  const resetFailed = openStream([frame({ type: 'stream.reset' }, next)])
  const resetSucceeded = closedStream([frame({ type: 'stream.reset' }, next)])
  const held = openStream()
  const responses = [closedStream([frame(createEvent(1), previous)]), resetFailed.response, resetSucceeded, held.response]
  const onReset = vi.fn().mockRejectedValueOnce(new Error('snapshot failed')).mockResolvedValue(undefined)
  const client = Client.create({
    baseUrl: 'https://service.example',
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(responses[requests.length - 1]!)
    },
  })
  const unsubscribe = client.subscribe(scope, { onEvent: () => {}, onReset })
  onTestFinished(unsubscribe)
  for (const delay of [10, 20, 40]) {
    await flushUntil(() => vi.getTimerCount() === 1)
    vi.advanceTimersByTime(delay)
  }
  await flushUntil(() => requests.length === 4)
  expect(requests.map(request => request.headers.get('last-event-id'))).toEqual([null, previous, previous, next])
  expect(onReset).toHaveBeenCalledTimes(2)
  await resetFailed.cancelled
  unsubscribe()
  await held.cancelled
})

test.each([
  { message: { type: 'unknown.event' }, id: `${streamId}:9` },
  { message: createEvent(9), id: 'invalid-cursor' },
])('无效消息或游标不越过最后已确认事实 %j', async (invalid) => {
  vi.useFakeTimers()
  const requests: Request[] = []
  const held = openStream()
  const first = openStream([
    frame(createEvent(1), `${streamId}:1`),
    frame(invalid.message, invalid.id),
    frame(createEvent(10), `${streamId}:10`),
  ])
  const onEvent = vi.fn()
  const client = Client.create({
    baseUrl: 'https://service.example',
    retry: { initialDelayMs: 10 },
    fetch: (input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(requests.length === 1 ? first.response : held.response)
    },
  })
  const unsubscribe = client.subscribe(scope, { onEvent })
  onTestFinished(unsubscribe)
  await first.cancelled
  await flushUntil(() => vi.getTimerCount() === 1)
  vi.advanceTimersByTime(10)
  await flushUntil(() => requests.length === 2)
  expect(onEvent).toHaveBeenCalledTimes(1)
  expect(requests[1]?.headers.get('last-event-id')).toBe(`${streamId}:1`)
  unsubscribe()
  await held.cancelled
})

test.each([false, true])('连续断线只通知一次且错误观察者失败不会阻断退避，异步=%s', async (asynchronous) => {
  vi.useFakeTimers()
  let connections = 0
  const cursors: Array<string | null> = []
  const onError = vi.fn(() => {
    const error = new Error('observer failed')
    if (asynchronous)
      return Promise.reject(error)
    throw error
  })
  const onEvent = vi.fn()
  const client = Client.create({
    baseUrl: 'https://service.example',
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
    fetch: (input, init) => {
      connections++
      cursors.push(new Request(input, init).headers.get('last-event-id'))
      return Promise.resolve(closedStream([
        frame({ type: 'stream.connected' }, `${streamId}:0`),
        ...(connections === 4 ? [frame(createEvent(1), `${streamId}:1`)] : []),
      ]))
    },
  })
  const unsubscribe = client.subscribe(scope, { onEvent, onError })
  onTestFinished(unsubscribe)
  await flushUntil(() => vi.getTimerCount() === 1)
  expect(onError).toHaveBeenCalledTimes(1)
  for (const [index, delay] of [10, 20, 40].entries()) {
    vi.advanceTimersByTime(delay - 1)
    await Promise.resolve()
    expect(connections).toBe(index + 1)
    vi.advanceTimersByTime(1)
    await flushUntil(() => connections === index + 2 && vi.getTimerCount() === 1)
    expect(onError).toHaveBeenCalledTimes(index === 2 ? 2 : 1)
  }
  expect(onEvent).toHaveBeenCalledTimes(1)
  expect(cursors).toEqual([null, null, null, null])
  vi.advanceTimersByTime(9)
  await Promise.resolve()
  expect(connections).toBe(4)
  unsubscribe()
  expect(vi.getTimerCount()).toBe(0)
})

test('退避期间取消立即释放计时器，不再创建请求', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(() => Promise.reject(new Error('offline')))
  const client = Client.create({ baseUrl: 'https://service.example', fetch })
  const unsubscribe = client.subscribe(scope, { onEvent: () => {} })
  onTestFinished(unsubscribe)
  await flushUntil(() => vi.getTimerCount() === 1)

  unsubscribe()
  unsubscribe()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('无新事件时取消主动释放 reader，宿主 Fetch 不必自行绑定正文信号', async () => {
  const held = openStream([frame({ type: 'stream.connected' }, `${streamId}:0`)])
  const fetch = vi.fn(() => Promise.resolve(held.response))
  const onEvent = vi.fn()
  const onError = vi.fn()
  const client = Client.create({ baseUrl: 'https://service.example', fetch })
  const unsubscribe = client.subscribe(scope, { onEvent, onError })
  onTestFinished(unsubscribe)
  await flushUntil(() => held.response.body?.locked === true)

  unsubscribe()
  await held.cancelled
  expect(onEvent).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})
