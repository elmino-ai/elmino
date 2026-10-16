import type { ServerAuthorization } from '../src/index'
import { defineAgent } from '@elmino/agent'
import { defineElmino } from '@elmino/core'
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { defineServer } from '../src/index'
import { createGatedModel, createServerHarness, threadTarget } from './support/server'

test('SDK 创建任务只等待接纳，真实模型尚未完成时已经返回线程，关闭不关闭宿主 Store', async () => {
  const harness = await createServerHarness()
  const gate = createGatedModel()
  harness.models.push(gate.model)
  const client = harness.client()
  const request = harness.request()
  const accepted = await client.rpc.turn.create(request)
  await gate.entered

  expect(accepted.threadId).toBe(request.threadId)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')
  expect(gate.signal?.aborted).toBe(false)
  gate.release()
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  const state = await client.rpc.thread.get(threadTarget(request))
  expect(state.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ type: 'text', text: '任务完成' }))
  expect(harness.events.filter(event => event.type === 'turn.completed')).toHaveLength(1)
  expect(harness.captureErrors).toEqual([])
  expect(harness.errors).toEqual([])
  const closing = harness.server.close()
  expect(harness.server.close()).toBe(closing)
  await closing
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  expect((await harness.stores.primary.store.threads.read(request.threadId))?.id).toBe(request.threadId)
  expect((await harness.server.fetch(new Request('https://elmino.test/rpc/meta/health'))).status).toBe(503)
})

test('取消 SDK 事件订阅只关闭观察，不取消已接纳的任务', async () => {
  const harness = await createServerHarness()
  const gate = createGatedModel()
  harness.models.push(gate.model)
  const client = harness.client()
  const request = harness.request()
  await client.rpc.turn.create(request)
  await gate.entered
  const connected = Promise.withResolvers<void>()
  const observed: string[] = []
  const subscriptionErrors: unknown[] = []
  const stop = client.subscribe(threadTarget(request), {
    onReset: () => connected.resolve(),
    onEvent: (event) => { observed.push(event.type) },
    onError: (error) => { subscriptionErrors.push(error) },
  })
  onTestFinished(stop)
  await connected.promise
  stop()
  expect(gate.signal?.aborted).toBe(false)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')
  const observedAtStop = [...observed]
  gate.release()
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  expect(observed).toEqual(observedAtStop)
  expect(subscriptionErrors).toEqual([])
})

test('同一 HTTP batch 中每个 procedure 独立授权，后续请求使用新凭据', async () => {
  let token = 'allowed'
  const authorize = vi.fn((context: ServerAuthorization) => (
    context.request.headers.get('authorization') === 'Bearer allowed' && context.path.join('.') !== 'agent.list'
  ))
  const harness = await createServerHarness({ authorize })
  const client = harness.client(() => ({ authorization: `Bearer ${token}` }))
  const [health, agents] = await Promise.allSettled([
    client.rpc.meta.health({}),
    client.rpc.agent.list({}),
  ])

  expect(harness.requests).toHaveLength(1)
  expect(health).toEqual({ status: 'fulfilled', value: { status: 'ok' } })
  expect(agents).toMatchObject({ status: 'rejected', reason: { code: 'UNAUTHORIZED' } })
  expect(authorize.mock.calls.map(([context]) => context.path.join('.')).sort()).toEqual(['agent.list', 'meta.health'])
  token = 'denied'
  await expect(client.rpc.meta.health({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(authorize).toHaveBeenCalledTimes(3)
})

test('线程读取、列表与事件订阅在 Agent 和工作区之间保持隔离', async () => {
  const harness = await createServerHarness()
  const client = harness.client()
  const requests = [
    harness.request(),
    harness.request({ agentId: 'beta' }),
    harness.request({ workspaceId: 'secondary' }),
  ]
  for (const [index, request] of requests.entries()) {
    harness.models.push(createModel([response([{ type: 'text', text: `result ${index}` }])]).model)
    await client.rpc.turn.create(request)
  }
  await vi.waitFor(async () => {
    const turns = await Promise.all(requests.map(request => harness.stores[request.workspaceId === 'secondary' ? 'secondary' : 'primary'].store.turns.read(request.turnId)))
    expect(turns.map(turn => turn?.status)).toEqual(['completed', 'completed', 'completed'])
  })
  for (const request of requests) {
    const page = await client.rpc.thread.list({ agentId: request.agentId, workspaceId: request.workspaceId })
    expect(page.items.map(item => item.threadId)).toEqual([request.threadId])
  }
  const original = requests[0]!
  for (const foreign of [{ ...threadTarget(original), agentId: 'beta' }, { ...threadTarget(original), workspaceId: 'secondary' }]) {
    await expect(client.rpc.thread.get(foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.rpc.turn.interrupt({ ...foreign, turnId: original.turnId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.rpc.events.subscribe(foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
  expect((await harness.stores.primary.store.turns.read(original.turnId))?.status).toBe('completed')
})

test('重复 Turn 在运行中和终态后均被拒绝，不能重跑或覆盖原持久事实', async () => {
  const harness = await createServerHarness()
  const gate = createGatedModel()
  harness.models.push(gate.model, gate.model, gate.model)
  const client = harness.client()
  const request = harness.request()
  await client.rpc.turn.create(request)
  await gate.entered
  await expect(client.rpc.turn.create(request)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(gate.requests).toHaveLength(1)
  expect(gate.signal?.aborted).toBe(false)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')
  gate.release()
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  const settled = await harness.stores.primary.store.turns.read(request.turnId)
  await expect(client.rpc.turn.create(request)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await harness.stores.primary.store.turns.read(request.turnId)).toEqual(settled)
  expect(gate.requests).toHaveLength(1)
})

test('审批中断关闭 Server 后，在同一宿主 Store 通过冻结配置恢复且只执行一次工具', async () => {
  const execute = vi.fn(({ value }: { value: string }) => value)
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '执行需要审批的任务', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  const initial = createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'approved' } }], 'tool-calls'),
    new Error('转人工审批'),
  ])
  initial.model.config.id = 'host-original-model'
  initial.model.config.label = 'Original Model'
  const frozenConfig = structuredClone(initial.model.config)
  harness.models.push(initial.model)
  const client = harness.client()
  const request = harness.request({ approvalMode: 'auto', modelId: 'host-original-model' })
  await client.rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  })
  const interrupted = await harness.stores.primary.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(interrupted?.interrupt))!
  expect(interrupt.interaction).toBe('tool_approval')
  expect(execute).not.toHaveBeenCalled()
  await harness.restart()
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  initial.model.config.id = 'host-new-default'
  initial.model.config.label = 'Changed Default'
  const restored = createModel([response([{ type: 'text', text: '恢复完成' }])])
  Object.assign(restored.model.config, frozenConfig)
  harness.models.push(restored.model)
  const resume = { ...threadTarget(request), turnId: request.turnId, interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'native_work' }] } }
  await client.rpc.turn.resume(resume)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  expect(harness.modelRequests.at(-1)?.frozenConfig).toEqual(frozenConfig)
  expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'approved' }, expect.anything())
  expect(restored.requests).toHaveLength(1)
  await expect(client.rpc.turn.resume(resume)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(execute).toHaveBeenCalledTimes(1)
})

test('中断必须命中活跃 Turn，错误 Turn ID 不会打断同一线程的当前任务', async () => {
  const harness = await createServerHarness()
  const gate = createGatedModel()
  harness.models.push(gate.model)
  const client = harness.client()
  const request = harness.request()
  await client.rpc.turn.create(request)
  await gate.entered
  await client.rpc.turn.interrupt({ ...threadTarget(request), turnId: createId('turn') })
  expect(gate.signal?.aborted).toBe(false)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')
  const state = await client.rpc.turn.interrupt({ ...threadTarget(request), turnId: request.turnId, reason: 'user interrupted' })
  expect(gate.signal?.aborted).toBe(true)
  expect(state.runtime.status).toBe('interrupted')
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  expect(harness.events.filter(event => event.type === 'turn.interrupted')).toHaveLength(1)
})

test.each(['constructor', 'toString', '__proto__'])('未注册的原型键 %s 返回 NOT_FOUND，不能打开宿主工作区', async (agentId) => {
  const workspace = vi.fn(() => {
    throw new Error('不应解析工作区')
  })
  const server = defineServer({
    elmino: defineElmino({
      agents: {},
      workspace,
      models: () => { throw new Error('不应解析模型') },
    }),
  })
  onTestFinished(() => server.close())
  const client = Client.create({
    baseUrl: 'https://elmino.test',
    fetch: (input, init) => server.fetch(new Request(input, init)),
  })

  await expect(client.rpc.thread.list({ agentId, workspaceId: 'primary' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(workspace).not.toHaveBeenCalled()
})

test('注册键与 Agent 定义身份不一致时在创建 Server 时拒绝', () => {
  const workspace = vi.fn(() => {
    throw new Error('不应解析工作区')
  })
  const agent = defineAgent({
    id: 'actual',
    systemPrompt: 'test',
    runtime: { create: () => { throw new Error('不应创建 Runtime') } },
  })

  expect(() => defineServer({
    elmino: defineElmino({
      agents: { alias: agent },
      workspace,
      models: () => { throw new Error('不应解析模型') },
    }),
  })).toThrow(TypeError)
  expect(workspace).not.toHaveBeenCalled()
})

test.each(['sync', 'async'])('输入预处理支持 %s 回调并持久化处理后的消息', async (mode) => {
  const harness = await createServerHarness({
    prepareInput: () => {
      const parts = [{ type: 'text' as const, text: 'prepared input' }]
      return mode === 'sync' ? parts : Promise.resolve(parts)
    },
  })
  const model = createModel([response([{ type: 'text', text: '完成' }])])
  harness.models.push(model.model)
  const request = harness.request()
  await harness.client().rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  const state = await harness.client().rpc.thread.get(threadTarget(request))
  expect(state.messages.flatMap(message => message.parts))
    .toContainEqual(expect.objectContaining({ type: 'text', text: 'prepared input' }))
  expect(model.requests[0]!.messages.flatMap(message => message.parts))
    .toContainEqual({ type: 'text', text: 'prepared input' })
})

test('异步输入预处理持有接纳预留，重复 Turn 不会重复执行附件副作用', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const prepareInput = vi.fn(async () => {
    entered.resolve()
    await release.promise
    return [{ type: 'text' as const, text: 'prepared input' }]
  })
  const harness = await createServerHarness({ prepareInput })
  onTestFinished(() => release.resolve())
  const model = createModel([response([{ type: 'text', text: '完成' }])])
  harness.models.push(model.model, model.model)
  const client = harness.client()
  const request = harness.request()
  const pending = client.rpc.turn.create(request)
  pending.catch(() => undefined)

  try {
    await entered.promise
    await expect(client.rpc.turn.create(request)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(prepareInput).toHaveBeenCalledOnce()
    expect(model.requests).toHaveLength(0)
  }
  finally { release.resolve() }
  await pending
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  expect(model.requests[0]!.messages.flatMap(message => message.parts))
    .toContainEqual({ type: 'text', text: 'prepared input' })
})

test('关闭 Elmino 等待已进入的异步输入预处理收束，关闭后不再进入模型采样', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const harness = await createServerHarness({
    prepareInput: async () => {
      entered.resolve()
      await release.promise
      return [{ type: 'text', text: 'prepared input' }]
    },
  })
  onTestFinished(() => release.resolve())
  const model = createModel([response([{ type: 'text', text: '不能开始采样' }])])
  harness.models.push(model.model)
  const request = harness.request()
  const pending = harness.client().rpc.turn.create(request)
  pending.catch(() => undefined)
  await entered.promise
  let closed = false
  const closing = harness.elmino.close().then(() => {
    closed = true
  })
  closing.catch(() => undefined)

  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(model.requests).toHaveLength(0)
  }
  finally { release.resolve() }
  expect((await pending).threadId).toBe(request.threadId)
  await closing
  expect(model.requests).toHaveLength(0)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
})

test('宿主事件观察器失败会报告 onError，不撤销任务事实或阻断 SDK 事件流', async () => {
  const failure = new Error('host observer failure')
  const harness = await createServerHarness({
    onEvent: (_, event) => {
      if (event.type === 'turn.completed')
        throw failure
    },
  })
  const client = harness.client()
  const connected = Promise.withResolvers<void>()
  const observed: string[] = []
  const streamErrors: unknown[] = []
  const stop = client.subscribe({ agentId: 'alpha', workspaceId: 'primary' }, {
    onReset: () => connected.resolve(),
    onEvent: (event) => { observed.push(event.type) },
    onError: (error) => { streamErrors.push(error) },
  })
  onTestFinished(stop)
  await connected.promise
  harness.models.push(createModel([response([{ type: 'text', text: '仍然完成' }])]).model)
  const request = harness.request()
  await client.rpc.turn.create(request)
  await vi.waitFor(() => {
    expect(observed).toContain('turn.completed')
    expect(harness.errors).toContain(failure)
  })
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  expect(harness.events.filter(event => event.type === 'turn.completed')).toHaveLength(1)
  expect(streamErrors).toEqual([])
})

test('文档缺少宿主输入处理器时保留 BAD_REQUEST，不采样模型或创建运行事实', async () => {
  const harness = await createServerHarness()
  const model = createModel([response([{ type: 'text', text: '不能开始采样' }])])
  harness.models.push(model.model)
  const request = harness.request({ input: [{
    type: 'document',
    name: 'sample.pdf',
    extension: 'pdf',
    data: 'ZG9jdW1lbnQ=',
  }] })

  await expect(harness.client().rpc.turn.create(request)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 })
  expect(model.requests).toHaveLength(0)
  expect(await harness.stores.primary.store.turns.read(request.turnId)).toBeUndefined()
  expect(await harness.stores.primary.store.threads.read(request.threadId)).toBeUndefined()
})
