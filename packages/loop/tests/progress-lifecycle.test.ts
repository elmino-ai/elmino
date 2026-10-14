import type { ToolExecutionContext } from '@elmino/tool'
import { isPlainRecord } from '@elmino/shared'
import { defineTools } from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import * as z from 'zod'
import { createHarness } from './support/harness.js'
import { createModel, response } from './support/model.js'

test('cancellation drains accepted progress before terminal commit and rejects late writes', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error('tool aborted')
  let progress: Promise<void> | undefined
  let callback: ToolExecutionContext['onToolProgress']
  const tools = defineTools({
    work: {
      description: 'Progress until cancelled',
      schema: z.object({}),
      execute: (_, context) => {
        callback = context.onToolProgress
        progress = Promise.resolve(callback?.('partial'))
        progress.catch(() => undefined)
        return new Promise<string>((_resolve, reject) => {
          context.signal!.addEventListener('abort', () => reject(failure), { once: true })
        })
      },
    },
  })
  const harness = await createHarness({
    tools,
    signal: controller.signal,
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    ]).model,
    onEvent: async (event) => {
      if (event.type === 'message.part.delta'
        && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.delta)
        && typeof event.payload.delta.output === 'string') {
        started.resolve()
        await release.promise
      }
    },
  })
  let finished = false
  const invocation = harness.invoke().then(
    () => { finished = true },
    (error: unknown) => {
      finished = true
      return error
    },
  )
  await started.promise
  try {
    controller.abort(failure)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(finished).toBe(false)
    expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('running')
  }
  finally { release.resolve() }
  expect(await invocation).toBe(failure)
  await progress
  const [terminal] = await harness.store.toolCalls.list({ turnId: harness.turnId })
  expect(terminal).toMatchObject({ status: 'failed', completedAt: expect.any(String) })
  const eventCount = harness.events.length
  await callback?.('late output')
  expect(harness.events).toHaveLength(eventCount)
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]).toEqual(terminal)
})

test('cancellation while the started observer waits cannot begin tool side effects', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const execute = vi.fn(() => 'unexpected')
  const harness = await createHarness({
    signal: controller.signal,
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    ]).model,
    tools: defineTools({ work: { description: 'Work', schema: z.object({}), execute } }),
    onEvent: async (event) => {
      if (event.type === 'message.part.updated'
        && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.part)
        && event.payload.part.type === 'tool'
        && event.payload.part.status === 'running') {
        started.resolve()
        await release.promise
      }
    },
  })
  const invocation = harness.invoke().catch((error: unknown) => error)
  await started.promise
  controller.abort()
  release.resolve()
  expect(await invocation).toBeInstanceOf(Error)
  expect(execute).not.toHaveBeenCalled()
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('failed')
})

test.each([false, true])('progress storage failure preserves handler failure precedence: %s', async (abort) => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const progressFailure = new Error('progress storage failed')
  const handlerFailure = new Error('handler aborted')
  const tools = defineTools({
    work: {
      description: 'Progress',
      schema: z.object({}),
      execute: (_, context) => {
        Promise.resolve(context.onToolProgress?.('partial')).catch(() => undefined)
        return abort
          ? new Promise<string>((_resolve, reject) => {
              context.signal!.addEventListener('abort', () => reject(handlerFailure), { once: true })
            })
          : 'completed'
      },
    },
  })
  const harness = await createHarness({
    tools,
    signal: controller.signal,
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    ]).model,
    onEvent: async (event) => {
      if (event.type === 'message.part.delta' && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.delta) && typeof event.payload.delta.output === 'string') {
        started.resolve()
        await release.promise
      }
    },
  })
  const invocation = harness.invoke().catch((error: unknown) => error)
  await started.promise
  vi.spyOn(harness.store, 'transaction').mockRejectedValueOnce(progressFailure)
  if (abort)
    controller.abort(handlerFailure)
  release.resolve()
  expect(await invocation).toBe(abort ? handlerFailure : progressFailure)
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('failed')
})

test('fire-and-forget progress owns rejection while its handler remains active', async () => {
  const started = Promise.withResolvers<void>()
  const releaseProgress = Promise.withResolvers<void>()
  const releaseHandler = Promise.withResolvers<string>()
  const progressFailed = Promise.withResolvers<void>()
  const failure = new Error('progress storage failed')
  const unhandled = vi.fn()
  const harness = await createHarness({
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    ]).model,
    tools: defineTools({
      work: {
        description: 'Progress without awaiting it',
        schema: z.object({}),
        execute: (_, context) => {
          context.onToolProgress?.('partial')
          return releaseHandler.promise
        },
      },
    }),
    onEvent: async (event) => {
      if (event.type === 'message.part.delta' && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.delta) && typeof event.payload.delta.output === 'string') {
        started.resolve()
        await releaseProgress.promise
      }
    },
  })
  process.on('unhandledRejection', unhandled)
  const invocation = harness.invoke().catch((error: unknown) => error)
  try {
    await started.promise
    vi.spyOn(harness.store, 'transaction').mockImplementationOnce(() => {
      progressFailed.resolve()
      return Promise.reject(failure)
    })
    releaseProgress.resolve()
    await progressFailed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).not.toHaveBeenCalled()
    expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('running')
  }
  finally {
    releaseProgress.resolve()
    releaseHandler.resolve('completed')
    process.off('unhandledRejection', unhandled)
  }
  expect(await invocation).toBe(failure)
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('failed')
})

test('normalized handler failure keeps its result when accepted progress also fails', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const primary = new Error('primary handler failure')
  const harness = await createHarness({
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
      response([{ type: 'text', text: 'handled failure' }]),
    ]).model,
    tools: defineTools({
      work: {
        description: 'Fail after publishing progress',
        schema: z.object({}),
        execute: (_, context) => {
          context.onToolProgress?.('partial')
          throw primary
        },
      },
    }),
    onEvent: async (event) => {
      if (event.type === 'message.part.delta' && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.delta) && typeof event.payload.delta.output === 'string') {
        started.resolve()
        await release.promise
      }
    },
  })
  const invocation = harness.invoke()
  await started.promise
  vi.spyOn(harness.store, 'transaction').mockRejectedValueOnce(new Error('secondary progress failure'))
  release.resolve()
  await expect(invocation).resolves.toMatchObject({ response: { parts: [{ type: 'text', text: 'handled failure' }] } })
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0])
    .toMatchObject({ status: 'failed', errorMessage: primary.message })
  const results = (await harness.store.canonical.listParts(harness.threadId))
    .filter(part => part.type === 'tool-result')
  expect(results).toHaveLength(1)
  const result = await harness.store.canonical.readPart(harness.threadId, results[0]!.id)
  expect(result?.content).toMatchObject({ error: true, result: `错误：${primary.message}` })
})
