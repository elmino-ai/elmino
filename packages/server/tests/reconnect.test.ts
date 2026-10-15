import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import { parseRuntimeEventCursor } from '@elmino/protocol'
import { Client } from '@elmino/sdk'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { getEventMeta } from '@orpc/server'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { listen } from '../src/node/index'
import { createGatedModel, createServerHarness, threadTarget } from './support/server'

/** 记录真实重连发出的 SSE 游标，所有 HTTP 均经过本机 TCP */
function createNetworkClient(baseUrl: string, subscriptions: Request[]): Client {
  return Client.create({
    baseUrl,
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
    fetch: (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.endsWith('/events/subscribe'))
        subscriptions.push(request)
      return globalThis.fetch(request)
    },
  })
}

test('只断开 TCP 不取消任务，原 SDK 沿已确认游标回放离线期间完成的事实', async () => {
  const harness = await createServerHarness()
  const model = createGatedModel('离线期间完成')
  harness.models.push(model.model)
  let listener = await listen({ server: harness.server })
  const port = Number(new URL(listener.url).port)
  const subscriptions: Request[] = []
  const client = createNetworkClient(listener.url, subscriptions)
  const request = harness.request()
  const ready = Promise.withResolvers<void>()
  const observed: RuntimeEvent[] = []
  const errors: unknown[] = []
  let resets = 0
  let lastObservedCursor: string | undefined
  const stop = client.subscribe({ agentId: request.agentId, workspaceId: request.workspaceId }, {
    onReset() {
      resets++
      ready.resolve()
    },
    onEvent(event) {
      observed.push(event)
      lastObservedCursor = getEventMeta(event)?.id
    },
    onError: (error) => { errors.push(error) },
  })
  onTestFinished(async () => {
    stop()
    model.release()
    await listener.close()
    await harness.server.close()
  })
  await ready.promise
  await client.rpc.turn.create(request)
  await model.entered
  await vi.waitFor(() => {
    expect(observed.some(event => event.type === 'turn.started' && event.turnId === request.turnId)).toBe(true)
  })
  await listener.close()
  await vi.waitFor(() => {
    expect(subscriptions.length).toBeGreaterThan(1)
  })
  const cursor = subscriptions[1]?.headers.get('last-event-id')
  expect(cursor).toBe(lastObservedCursor)
  expect(parseRuntimeEventCursor(cursor)).toBeDefined()
  expect(model.signal?.aborted).toBe(false)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')

  model.release()
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
    expect(harness.events.some(event => event.type === 'turn.completed' && event.turnId === request.turnId)).toBe(true)
  })
  expect(observed.some(event => event.type === 'turn.completed')).toBe(false)
  listener = await listen({ server: harness.server, port })
  await vi.waitFor(() => {
    expect(observed.filter(event => event.type === 'turn.completed' && event.turnId === request.turnId)).toHaveLength(1)
  })
  expect(resets).toBe(1)
  expect(errors).toHaveLength(1)
  expect(model.requests).toHaveLength(1)
  expect(harness.modelRequests).toHaveLength(1)
  expect(await harness.stores.primary.store.turns.list(request.threadId)).toHaveLength(1)
  expect(await harness.stores.primary.store.steps.list(request.turnId)).toMatchObject([{ status: 'completed' }])
  expect(new Set(observed.map(event => event.id)).size).toBe(observed.length)
  expect(harness.events.filter(event => event.type === 'turn.completed' && event.turnId === request.turnId)).toHaveLength(1)
  expect(harness.errors).toEqual([])
})

test('Server 重启切换事件流 epoch，原 SDK reset 读取持久审批并用冻结配置恢复一次', async () => {
  const execute = vi.fn(({ value }: { value: string }) => value)
  const harness = await createServerHarness({
    tools: defineTools({
      work: { description: '执行需要审批的工作', schema: z.object({ value: z.string() }), approval: 'auto', execute },
    }),
  })
  const initial = createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'approved over TCP' } }], 'tool-calls'),
    new Error('评审不可用，等待人工审批'),
  ])
  initial.model.config.id = 'host-frozen-model'
  initial.model.config.label = 'Frozen Model'
  const frozenConfig = structuredClone(initial.model.config)
  harness.models.push(initial.model)
  let listener = await listen({ server: harness.server })
  const port = Number(new URL(listener.url).port)
  const subscriptions: Request[] = []
  const client = createNetworkClient(listener.url, subscriptions)
  const request = harness.request({ approvalMode: 'auto', modelId: frozenConfig.id })
  const ready = Promise.withResolvers<void>()
  const resetStates: ThreadState[] = []
  const observed: Array<{ event: RuntimeEvent, cursor?: string }> = []
  const errors: unknown[] = []
  let resets = 0
  const stop = client.subscribe({ agentId: request.agentId, workspaceId: request.workspaceId }, {
    async onReset() {
      resets++
      if (resets === 1) {
        ready.resolve()
        return
      }
      resetStates.push(await client.rpc.thread.get(threadTarget(request)))
    },
    onEvent(event) {
      observed.push({ event, cursor: getEventMeta(event)?.id })
    },
    onError: (error) => { errors.push(error) },
  })
  onTestFinished(async () => {
    stop()
    await listener.close()
    await harness.server.close()
  })
  await ready.promise
  await client.rpc.turn.create(request)
  await vi.waitFor(() => {
    expect(observed.some(({ event }) => event.type === 'turn.interrupted' && event.turnId === request.turnId)).toBe(true)
  })
  const pending = await harness.stores.primary.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))
  expect(interrupt?.interaction).toBe('tool_approval')
  expect(pending?.status).toBe('interrupted')
  expect(execute).not.toHaveBeenCalled()
  if (!interrupt)
    throw new Error('未产生可持久恢复的审批中断')

  await listener.close()
  await vi.waitFor(() => {
    expect(subscriptions.length).toBeGreaterThan(1)
  })
  const oldCursor = subscriptions[1]?.headers.get('last-event-id')
  expect(oldCursor).toBe(observed.at(-1)?.cursor)
  const oldEpoch = parseRuntimeEventCursor(oldCursor)?.streamId
  expect(oldEpoch).toBeDefined()
  await harness.server.close()
  await harness.restart()
  initial.model.config.id = 'changed-host-default'
  initial.model.config.label = 'Changed Default'
  const restored = createModel([response([{ type: 'text', text: 'TCP 恢复完成' }])])
  Object.assign(restored.model.config, frozenConfig)
  harness.models.push(restored.model)
  listener = await listen({ server: harness.server, port })
  await vi.waitFor(() => {
    expect(resetStates).toHaveLength(1)
  })
  expect(resets).toBe(2)
  expect(resetStates[0]?.runtime.interrupt).toMatchObject({ id: interrupt.id, turnId: request.turnId, status: 'pending' })
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  expect(execute).not.toHaveBeenCalled()

  const resume = {
    ...threadTarget(request),
    turnId: request.turnId,
    interruptId: interrupt.id,
    response: { decisions: [{ type: 'approve', callId: 'native_work' }] },
  }
  await client.rpc.turn.resume(resume)
  await vi.waitFor(() => {
    expect(observed.filter(({ event }) => event.type === 'turn.completed' && event.turnId === request.turnId)).toHaveLength(1)
  })
  const completed = observed.find(({ event }) => event.type === 'turn.completed' && event.turnId === request.turnId)
  expect(parseRuntimeEventCursor(completed?.cursor)?.streamId).not.toBe(oldEpoch)
  expect(parseRuntimeEventCursor(completed?.cursor)).toBeDefined()
  expect(harness.modelRequests.at(-1)?.frozenConfig).toEqual(frozenConfig)
  expect(restored.requests).toHaveLength(1)
  expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'approved over TCP' }, expect.anything())
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  await expect(client.rpc.turn.resume(resume)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(errors).toHaveLength(1)
  expect(harness.errors).toEqual([])
})
