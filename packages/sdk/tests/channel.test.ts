import type { RuntimeEventSubscribeInput } from '@elmino/api'
import type { Client } from '../src/client/client'
import type { ClientRetryOptions, RuntimeEventSubscribeHandlers } from '../src/client/types'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createEventChannels } from '../src/events/channel'
import { createEvent, flushUntil, scope } from './support/stream'

/** 手动推进底层连接，验证共享层不会创建额外网络或跳过观察者校准 */
function fixture(retry?: ClientRetryOptions) {
  const connections: { input: RuntimeEventSubscribeInput, handlers: RuntimeEventSubscribeHandlers, stop: ReturnType<typeof vi.fn> }[] = []
  const subscribe: Client['subscribe'] = (input, handlers) => {
    const stop = vi.fn()
    connections.push({ input, handlers, stop })
    return stop
  }
  return { connections, channels: createEventChannels(subscribe, retry) }
}

test('同工作区复用连接并本地过滤线程，最后一个观察者释放才关闭', async () => {
  const { connections, channels } = fixture()
  const first = vi.fn()
  const second = vi.fn()
  const event = createEvent(1)
  const releaseFirst = channels.subscribe({ ...scope, threadId: event.threadId }, { onEvent: first })
  const releaseSecond = channels.subscribe({ ...scope, threadId: 'other' }, { onEvent: second })
  expect(connections).toHaveLength(1)
  expect(connections[0]!.input).toEqual(scope)
  await connections[0]!.handlers.onEvent(event)
  expect(first).toHaveBeenCalledWith(event)
  expect(second).not.toHaveBeenCalled()
  releaseFirst()
  expect(connections[0]!.stop).not.toHaveBeenCalled()
  releaseSecond()
  releaseSecond()
  expect(connections[0]!.stop).toHaveBeenCalledTimes(1)
})

test('加入已就绪的通道先校准再连接，后续事件不能越过校准', async () => {
  const { connections, channels } = fixture()
  channels.subscribe(scope, { onEvent: () => undefined })
  await connections[0]!.handlers.onConnected?.()
  const gate = Promise.withResolvers<void>()
  const calls: string[] = []
  channels.subscribe(scope, {
    async onReset() {
      calls.push('reset')
      await gate.promise
    },
    onConnected: () => { calls.push('connected') },
    onEvent: () => { calls.push('event') },
  })
  const broadcast = connections[0]!.handlers.onEvent(createEvent(1))
  await Promise.resolve()
  expect(calls).toEqual(['reset'])
  gate.resolve()
  await broadcast
  await flushUntil(() => calls.length === 3)
  expect(calls).toEqual(['reset', 'connected', 'event'])
})

test('观察者与错误报告失败均不会阻断同通道的其他任务', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const { connections, channels } = fixture()
  const error = new Error('观察失败')
  const onError = vi.fn(() => {
    throw new Error('报告失败')
  })
  const reset = vi.fn()
  const good = vi.fn()
  const stopBroken = channels.subscribe(scope, {
    onEvent: () => {
      throw error
    },
    onError,
    onReset: reset,
  })
  const stopGood = channels.subscribe(scope, { onEvent: good })
  onTestFinished(() => {
    stopBroken()
    stopGood()
  })
  await connections[0]!.handlers.onConnected?.()
  await connections[0]!.handlers.onEvent(createEvent(1))
  await connections[0]!.handlers.onEvent(createEvent(2))
  await flushUntil(() => good.mock.calls.length === 2 && onError.mock.calls.length > 0)
  await vi.advanceTimersByTimeAsync(500)
  expect(good).toHaveBeenCalledTimes(2)
  expect(onError).toHaveBeenCalledWith(error)
  expect(reset.mock.calls.length).toBeGreaterThanOrEqual(1)
})

test('校准尚未完成时释放观察者，迟到结果不能接着投影或通知连接', async () => {
  const { connections, channels } = fixture()
  channels.subscribe(scope, { onEvent: () => undefined })
  await connections[0]!.handlers.onConnected?.()
  const gate = Promise.withResolvers<void>()
  const connected = vi.fn()
  const event = vi.fn()
  const stop = channels.subscribe(scope, { onReset: () => gate.promise, onConnected: connected, onEvent: event })
  const pending = connections[0]!.handlers.onEvent(createEvent(1))
  stop()
  gate.resolve()
  await pending
  expect(connected).not.toHaveBeenCalled()
  expect(event).not.toHaveBeenCalled()
})

test('不同工作区独立连接，释放后再次观察创建新的底层连接', () => {
  const { connections, channels } = fixture()
  const stop = channels.subscribe(scope, { onEvent: () => undefined })
  channels.subscribe({ ...scope, workspaceId: 'second' }, { onEvent: () => undefined })
  expect(connections).toHaveLength(2)
  stop()
  channels.subscribe(scope, { onEvent: () => undefined })
  expect(connections).toHaveLength(3)
})

test('观察回调等待同通道内另一任务，底层仍消费终态而不会互相锁住', async () => {
  const { connections, channels } = fixture()
  const completed = Promise.withResolvers<void>()
  let nestedReady = false
  let outerCompleted = false
  let stopNested: (() => void) | undefined
  const stopOuter = channels.subscribe(scope, {
    async onEvent(event) {
      if (event.id !== createEvent(1).id)
        return
      // 对应 watch listener / onEvent 内 await thread.run 或 approve 的生命周期
      stopNested = channels.subscribe(scope, {
        onReset: () => undefined,
        onConnected: () => { nestedReady = true },
        onEvent(value) {
          if (value.id === createEvent(2).id)
            completed.resolve()
        },
      })
      await completed.promise
      outerCompleted = true
    },
  })
  onTestFinished(() => {
    completed.resolve()
    stopNested?.()
    stopOuter()
  })
  await connections[0]!.handlers.onConnected?.()
  await connections[0]!.handlers.onEvent(createEvent(1))
  await flushUntil(() => nestedReady)
  expect(outerCompleted).toBe(false)
  await connections[0]!.handlers.onEvent(createEvent(2))
  await flushUntil(() => outerCompleted)
  expect(connections).toHaveLength(1)
  stopNested?.()
  stopOuter()
  expect(connections[0]!.stop).toHaveBeenCalledTimes(1)
}, 5_000)

test('慢观察者队列有界，过载事实合并成一次快照校准，其他观察者继续接收', async () => {
  const { connections, channels } = fixture()
  const gate = Promise.withResolvers<void>()
  const reset = vi.fn()
  const slow: string[] = []
  const fast: string[] = []
  let observedAfterReset = false
  const stopSlow = channels.subscribe(scope, {
    onReset: reset,
    async onEvent(event) {
      slow.push(event.id)
      if (slow.length === 1)
        await gate.promise
      else
        observedAfterReset = reset.mock.calls.length > 0
    },
  })
  const stopFast = channels.subscribe(scope, {
    onEvent: (event) => { fast.push(event.id) },
  })
  await connections[0]!.handlers.onConnected?.()
  onTestFinished(() => {
    gate.resolve()
    stopSlow()
    stopFast()
  })
  await connections[0]!.handlers.onEvent(createEvent(1))
  await flushUntil(() => slow.length === 1)
  // 每次等待仅推进传输，不等待慢观察者；它无法令另一条观察链积压
  for (let index = 2; index <= 1_000; index++) {
    await connections[0]!.handlers.onEvent(createEvent(index))
    await Promise.resolve()
  }
  await flushUntil(() => fast.length === 1_000)
  expect(slow).toHaveLength(1)
  expect(reset).not.toHaveBeenCalled()
  gate.resolve()
  await flushUntil(() => slow.at(-1) === createEvent(1_000).id)
  // 加上在途回调，保留数量仍受队列上限约束，而不是积压全部 1_000 个事实
  expect(slow.length).toBeLessThanOrEqual(129)
  expect(reset).toHaveBeenCalledTimes(1)
  expect(observedAfterReset).toBe(true)
  stopSlow()
  stopFast()
}, 5_000)

test('重置失败在有界退避后恢复快照，退避期间事实不引发额外查询', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const { connections, channels } = fixture()
  const failure = new Error('快照暂不可用')
  const reset = vi.fn().mockImplementationOnce(() => {
    throw failure
  })
  const errors = vi.fn()
  const event = vi.fn().mockImplementationOnce(() => {
    throw new Error('投影失败')
  })
  const stop = channels.subscribe(scope, { onEvent: event, onReset: reset, onError: errors })
  onTestFinished(stop)
  await connections[0]!.handlers.onConnected?.()
  await connections[0]!.handlers.onEvent(createEvent(1))
  await flushUntil(() => errors.mock.calls.length === 1)
  expect(reset).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(errors).toHaveBeenCalledTimes(2)
  expect(reset).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(1)
  await connections[0]!.handlers.onEvent(createEvent(2))
  expect(reset).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(reset).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(reset).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  await connections[0]!.handlers.onEvent(createEvent(3))
  await flushUntil(() => event.mock.calls.length === 2)
  expect(event).toHaveBeenLastCalledWith(createEvent(3))
}, 5_000)

test('快照503后没有后续事件仍自主重试，退避封顶且成功后恢复初始等待', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const { connections, channels } = fixture({ initialDelayMs: 10, maxDelayMs: 20 })
  const unavailable = new Error('503 Service Unavailable')
  let failures = 3
  const reset = vi.fn(() => {
    if (failures-- > 0)
      throw unavailable
  })
  const connected = vi.fn()
  const error = vi.fn()
  const stop = channels.subscribe(scope, { onEvent: () => undefined, onReset: reset, onConnected: connected, onError: error })
  onTestFinished(stop)
  await connections[0]!.handlers.onReset?.()
  await connections[0]!.handlers.onConnected?.()
  await flushUntil(() => error.mock.calls.length === 1 && vi.getTimerCount() === 1)
  expect(connected).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(reset).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(20)
  expect(reset).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(20)
  expect(reset).toHaveBeenCalledTimes(4)
  expect(connected).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)

  // 成功校准重置重试等待，下一次故障重新从10ms开始
  failures = 1
  await connections[0]!.handlers.onReset?.()
  await connections[0]!.handlers.onConnected?.()
  await flushUntil(() => vi.getTimerCount() === 1)
  await vi.advanceTimersByTimeAsync(9)
  expect(reset).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(1)
  expect(reset).toHaveBeenCalledTimes(6)
  expect(connected).toHaveBeenCalledTimes(2)
})

test('释放观察者清除唯一重试计时器，迟到时间不能查询或重启连接', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const { connections, channels } = fixture({ initialDelayMs: 10, maxDelayMs: 20 })
  const reset = vi.fn(() => {
    throw new Error('503 Service Unavailable')
  })
  const error = vi.fn()
  const stop = channels.subscribe(scope, { onEvent: () => undefined, onReset: reset, onError: error })
  onTestFinished(stop)
  await connections[0]!.handlers.onReset?.()
  await connections[0]!.handlers.onConnected?.()
  await flushUntil(() => error.mock.calls.length === 1 && vi.getTimerCount() === 1)
  stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(reset).toHaveBeenCalledTimes(1)
  expect(connections).toHaveLength(1)
  expect(connections[0]!.stop).toHaveBeenCalledTimes(1)
})

test('退避期间底层离线即清计时器，连接恢复前不伪造就绪', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const { connections, channels } = fixture({ initialDelayMs: 10, maxDelayMs: 20 })
  const reset = vi.fn().mockImplementationOnce(() => {
    throw new Error('503 Service Unavailable')
  })
  const connected = vi.fn()
  const stop = channels.subscribe(scope, { onEvent: () => undefined, onReset: reset, onConnected: connected })
  onTestFinished(stop)
  await connections[0]!.handlers.onReset?.()
  await connections[0]!.handlers.onConnected?.()
  await flushUntil(() => vi.getTimerCount() === 1)
  await connections[0]!.handlers.onError?.(new Error('连接离线'))
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(connected).not.toHaveBeenCalled()
  expect(reset).toHaveBeenCalledTimes(1)
  await connections[0]!.handlers.onConnected?.()
  await vi.advanceTimersByTimeAsync(20)
  await flushUntil(() => connected.mock.calls.length === 1)
  expect(reset).toHaveBeenCalledTimes(2)
})
