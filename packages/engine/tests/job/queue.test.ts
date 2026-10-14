import { JobQueue } from '@elmino/engine/job'
import { expect, test } from 'vitest'

/** -------------------- 测试 -------------------- */
test('JobQueue 按并发上限 FIFO 执行并公开活动状态', async () => {
  const queue = JobQueue.create(1)
  const gate = Promise.withResolvers<void>()
  const started: string[] = []
  const first = queue.submit('first', async () => {
    started.push('first')
    await gate.promise
  })
  const second = queue.submit('second', () => {
    started.push('second')
    return Promise.resolve()
  })
  const third = queue.submit('third', () => {
    started.push('third')
    return Promise.resolve()
  })

  expect(queue.status('first')).toBe('running')
  expect(queue.status('second')).toBe('queued')
  expect(queue.status('third')).toBe('queued')
  expect(started).toEqual(['first'])

  gate.resolve()
  await Promise.all([first, second, third])

  expect(started).toEqual(['first', 'second', 'third'])
  expect(queue.status('first')).toBeUndefined()
  expect(queue.status('second')).toBeUndefined()
  expect(queue.status('third')).toBeUndefined()
})

test('独立 JobQueue 不共享并发槽位', async () => {
  const firstQueue = JobQueue.create(1)
  const secondQueue = JobQueue.create(1)
  const firstGate = Promise.withResolvers<void>()
  const started: string[] = []
  const first = firstQueue.submit('first', async () => {
    started.push('first')
    await firstGate.promise
  })
  const waiting = firstQueue.submit('waiting', () => {
    started.push('waiting')
    return Promise.resolve()
  })
  const independent = secondQueue.submit('independent', () => {
    started.push('independent')
    return Promise.resolve()
  })

  await independent
  expect(started).toEqual(['first', 'independent'])
  expect(firstQueue.status('waiting')).toBe('queued')

  firstGate.resolve()
  await Promise.all([first, waiting])
  expect(started).toEqual(['first', 'independent', 'waiting'])
})

test('JobQueue 拒绝重复活动 ID 并允许结算后复用', async () => {
  const queue = JobQueue.create(Number.POSITIVE_INFINITY)
  const gate = Promise.withResolvers<void>()
  const first = queue.submit('same', () => gate.promise)

  await expect(
    queue.submit('same', () => Promise.resolve()),
  ).rejects.toThrow('Job 已提交: same')

  gate.resolve()
  await first
  await expect(
    queue.submit('same', () => Promise.resolve('reused')),
  ).resolves.toBe('reused')
})

test('JobQueue 从队列移除被取消和外部中止的 Job', async () => {
  const queue = JobQueue.create(1)
  const gate = Promise.withResolvers<void>()
  const started: string[] = []
  const first = queue.submit('first', () => gate.promise)
  const cancelled = queue.submit('cancelled', () => {
    started.push('cancelled')
    return Promise.resolve()
  })
  const externalController = new AbortController()
  const external = queue.submit('external', () => {
    started.push('external')
    return Promise.resolve()
  }, externalController.signal)

  expect(queue.cancel('cancelled')).toBe(true)
  externalController.abort('external-cancelled')
  await expect(cancelled).rejects.toBe('cancelled')
  await expect(external).rejects.toBe('external-cancelled')

  gate.resolve()
  await first

  expect(started).toEqual([])
  expect(queue.cancel('missing')).toBe(false)
})

test('JobQueue 运行取消等待任务清理完成后才释放槽位', async () => {
  const queue = JobQueue.create(1)
  const started = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const order: string[] = []
  const first = queue.submit('first', async (signal) => {
    order.push('first:start')
    started.resolve()

    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    order.push('first:aborted')
    await cleanup.promise
    order.push('first:cleaned')
    throw signal.reason
  })
  const second = queue.submit('second', () => {
    order.push('second:start')
    return Promise.resolve()
  })

  await started.promise
  expect(queue.cancel('first', 'running-cancelled')).toBe(true)
  await Promise.resolve()

  expect(queue.status('first')).toBe('running')
  expect(queue.status('second')).toBe('queued')
  expect(order).toEqual(['first:start', 'first:aborted'])

  cleanup.resolve()
  await expect(first).rejects.toBe('running-cancelled')
  await second

  expect(order).toEqual([
    'first:start',
    'first:aborted',
    'first:cleaned',
    'second:start',
  ])
})

test('JobQueue 在同步启动失败后释放槽位', async () => {
  const queue = JobQueue.create(1)
  const started: string[] = []
  const failed = queue.submit('failed', () => {
    started.push('failed')
    throw new Error('同步启动失败')
  })
  const next = queue.submit('next', () => {
    started.push('next')
    return Promise.resolve()
  })

  await expect(failed).rejects.toThrow('同步启动失败')
  await next

  expect(started).toEqual(['failed', 'next'])
})

test('JobQueue 幂等关闭并拒绝后续提交', async () => {
  const queue = JobQueue.create(1)
  let nestedClosing: Promise<void> | undefined
  const running = queue.submit('running', async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        nestedClosing = queue.close()
        resolve()
      }, { once: true })
    })
    throw signal.reason
  })
  const queued = queue.submit('queued', () => Promise.resolve())
  const closing = queue.close()

  expect(queue.close()).toBe(closing)
  expect(nestedClosing).toBe(closing)
  await expect(running).rejects.toThrow('JobQueue 正在关闭')
  await expect(queued).rejects.toThrow('JobQueue 正在关闭')
  await closing
  await expect(
    queue.submit('late', () => Promise.resolve()),
  ).rejects.toThrow('JobQueue 已经关闭')
})
