import type { ClientRunToolResult } from '@elmino/sdk'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { AgentServer } from '../src/index'
import { Client } from '@elmino/sdk'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { defineServer } from '../src/index'
import { listen } from '../src/node/index'
import { createGatedModel, createServerHarness, threadTarget } from './support/server'

/** 一次调用负责连接与输出，后续会话仅沿用 threadId，不重放先前轮次或其他线程 */
test('run 自动生成身份，工具与流式输出只通知一次，同线程续聊只返回本轮内容', async () => {
  const execute = vi.fn(({ value }: { value: string }) => `result:${value}`)
  const harness = await createServerHarness({ tools: defineTools({
    echo: { description: '返回输入', schema: z.object({ value: z.string() }), execute },
  }) })
  const firstModel = createModel([
    response([
      { type: 'reasoning', text: '先调用工具' },
      { type: 'tool-call', id: 'native_echo', name: 'echo', args: { value: 'first' } },
    ], 'tool-calls'),
    response([{ type: 'text', text: '第一轮完成' }]),
  ])
  harness.models.push(firstModel.model)
  const client = harness.client()
  const text: string[] = []
  const reasoning: string[] = []
  const tools: ClientRunToolResult[] = []
  const events: RuntimeEvent[] = []
  const first = await client.run({
    agentId: 'alpha',
    workspaceId: 'primary',
    input: '第一轮用户输入不可打印为助手输出',
    approvalMode: 'fullAccess',
    signal: AbortSignal.timeout(5_000),
    onText: (value) => { text.push(value) },
    onReasoning: (value) => { reasoning.push(value) },
    onToolResult: (part) => { tools.push(part) },
    onEvent: (event) => { events.push(event) },
  })

  expect(first).toMatchObject({ workspaceId: 'primary', status: 'completed' })
  expect(first.threadId).toMatch(/^thread_/u)
  expect(first.turnId).toMatch(/^turn_/u)
  expect(first.message).toMatchObject({ role: 'assistant', turnId: first.turnId })
  expect(text.join('')).toBe('第一轮完成')
  expect(reasoning.join('')).toBe('先调用工具')
  expect(tools).toMatchObject([{ toolName: 'echo', status: 'completed', output: 'result:first' }])
  expect(execute).toHaveBeenCalledTimes(1)
  expect(events.length).toBeGreaterThan(0)
  expect(events.every(event => event.threadId === first.threadId && event.turnId === first.turnId)).toBe(true)
  expect(new Set(events.map(event => event.id)).size).toBe(events.length)
  expect(firstModel.requests).toHaveLength(2)

  const secondModel = createGatedModel('第二轮完成')
  const unrelated = createModel([response([{ type: 'text', text: '其他线程不可打印' }])])
  harness.models.push(secondModel.model, unrelated.model)
  const nextText: string[] = []
  const nextReasoning = vi.fn()
  const nextTool = vi.fn()
  const nextEvents: RuntimeEvent[] = []
  const secondPromise = client.run({
    agentId: 'alpha',
    workspaceId: 'primary',
    threadId: first.threadId,
    input: [{ type: 'text', text: '继续第二轮' }],
    signal: AbortSignal.timeout(5_000),
    onText: (value) => { nextText.push(value) },
    onReasoning: nextReasoning,
    onToolResult: nextTool,
    onEvent: (event) => { nextEvents.push(event) },
  })
  // 在第二轮等待模型时，让同工作区的另一线程完成，验证工作区 SSE 的过滤归属
  secondPromise.catch(() => undefined)
  await secondModel.entered
  const foreignRequest = harness.request()
  await client.rpc.turn.create(foreignRequest)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(foreignRequest.turnId))?.status).toBe('completed')
  })
  secondModel.release()
  const second = await secondPromise

  expect(second.threadId).toBe(first.threadId)
  expect(second.turnId).not.toBe(first.turnId)
  expect(second.status).toBe('completed')
  expect(second.thread.turns.map(turn => turn.id)).toEqual([first.turnId, second.turnId])
  expect(nextText.join('')).toBe('第二轮完成')
  expect(nextReasoning).not.toHaveBeenCalled()
  expect(nextTool).not.toHaveBeenCalled()
  expect(nextEvents.every(event => event.threadId === second.threadId && event.turnId === second.turnId)).toBe(true)
  expect(nextEvents.some(event => event.type === 'turn.completed')).toBe(true)
  expect(secondModel.requests).toHaveLength(1)
  expect(unrelated.requests).toHaveLength(1)
})

test('模型失败作为 failed 结果返回，最终快照保留失败事实', async () => {
  const harness = await createServerHarness()
  const model = createModel([new Error('确定性模型失败')])
  harness.models.push(model.model)
  const result = await harness.client().run({
    agentId: 'alpha',
    workspaceId: 'primary',
    input: '触发模型失败',
    signal: AbortSignal.timeout(5_000),
  })

  expect(result.status).toBe('failed')
  expect(result.thread.turns.find(turn => turn.id === result.turnId)?.status).toBe('failed')
  expect((await harness.stores.primary.store.turns.read(result.turnId))?.errorMessage).toContain('确定性模型失败')
  expect(model.requests).toHaveLength(1)
})

test('审批中断作为 interrupted 结果返回，不替用户审批或自动重新提交', async () => {
  const execute = vi.fn()
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需人工审批的任务', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  const model = createModel([
    response([{ type: 'tool-call', id: 'native_approval', name: 'work', args: { value: 'pending' } }], 'tool-calls'),
    new Error('转人工审批'),
  ])
  harness.models.push(model.model)
  const result = await harness.client().run({
    agentId: 'alpha',
    workspaceId: 'primary',
    input: '执行工作',
    approvalMode: 'auto',
    signal: AbortSignal.timeout(5_000),
  })

  expect(result.status).toBe('interrupted')
  expect(result.thread.runtime.interrupt).toMatchObject({
    kind: 'interaction',
    interaction: 'tool_approval',
    status: 'pending',
    turnId: result.turnId,
  })
  expect(execute).not.toHaveBeenCalled()
  expect(harness.modelRequests).toHaveLength(1)
  expect(await harness.stores.primary.store.turns.list(result.threadId)).toHaveLength(1)
})

test('取消 run 只结束客户端等待，远端模型仍运行并可通过原身份查询完成结果', async () => {
  const harness = await createServerHarness()
  const model = createGatedModel('本地取消后远端完成')
  harness.models.push(model.model)
  const client = harness.client()
  const request = harness.request()
  const controller = new AbortController()
  onTestFinished(() => controller.abort())
  const pending = client.run({ ...request, signal: controller.signal })
  const reason = new Error('只取消本地等待')
  const rejected = expect(pending).rejects.toBe(reason)
  await model.entered
  controller.abort(reason)
  await rejected

  expect(model.signal?.aborted).toBe(false)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('running')
  expect(harness.events.some(event => event.type === 'turn.cancelled' || event.type === 'turn.interrupted')).toBe(false)
  model.release()
  await vi.waitFor(async () => {
    const state = await client.rpc.thread.get(threadTarget(request))
    expect(state.turns.find(turn => turn.id === request.turnId)?.status).toBe('completed')
    expect(state.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ type: 'text', text: '本地取消后远端完成' }))
  })
  expect(model.requests).toHaveLength(1)
})

test('订阅鉴权失败立即拒绝 run，未提交任务也未打开模型', async () => {
  const authorize = vi.fn(() => false)
  const harness = await createServerHarness({ authorize })
  const client = harness.client({ authorization: 'Bearer invalid-test-key' })
  await expect(client.run({
    agentId: 'alpha',
    workspaceId: 'primary',
    input: '不应执行',
    signal: AbortSignal.timeout(5_000),
  })).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })

  expect(authorize).toHaveBeenCalledTimes(1)
  expect(harness.requests).toHaveLength(1)
  expect(harness.requests[0]?.url).toContain('/events/subscribe')
  expect(harness.modelRequests).toEqual([])
  expect(await harness.stores.primary.store.turns.listAll()).toEqual([])
})

test('输出回调异常拒绝原错误并清理订阅，不重放回调或中断远端', async () => {
  const harness = await createServerHarness()
  const model = createModel([response([{ type: 'text', text: '远端正常完成' }])])
  harness.models.push(model.model)
  const client = harness.client()
  const request = harness.request()
  const failure = new Error('调用方输出处理失败')
  const onText = vi.fn(() => {
    throw failure
  })
  await expect(client.run({
    ...request,
    signal: AbortSignal.timeout(5_000),
    onText,
  })).rejects.toBe(failure)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })

  const subscriptions = harness.requests.filter(item => new URL(item.url).pathname.endsWith('/events/subscribe'))
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]?.signal.aborted).toBe(true)
  expect(onText).toHaveBeenCalledExactlyOnceWith('远端正常完成')
  expect(model.requests).toHaveLength(1)
  expect(harness.events.some(event => event.type === 'turn.cancelled' || event.type === 'turn.interrupted')).toBe(false)
})

/** 真实关闭 TCP 后才放行模型，离线完成无法通过首次 create 响应提前得知 */
test.each([false, true])('run 在 TCP 离线完成后自动恢复，切换 Server epoch=%s', async (replaceServer) => {
  const harness = await createServerHarness()
  const model = createGatedModel('断线期间完成的唯一回复')
  harness.models.push(model.model)
  let listener = await listen({ server: harness.server })
  let replacement: AgentServer | undefined
  const port = Number(new URL(listener.url).port)
  const subscriptions: Request[] = []
  let admissionReturned = false
  const controller = new AbortController()
  const observed: RuntimeEvent[] = []
  const text: string[] = []
  const started = Promise.withResolvers<void>()
  const client = Client.create({
    baseUrl: listener.url,
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const subscription = new URL(request.url).pathname.endsWith('/events/subscribe')
      if (subscription)
        subscriptions.push(request)
      const result = await globalThis.fetch(request)
      if (!subscription) {
        await result.clone().arrayBuffer()
        admissionReturned = true
      }
      return result
    },
  })
  onTestFinished(async () => {
    controller.abort()
    model.release()
    await listener.close()
    await replacement?.close()
  })
  const request = harness.request()
  const pending = client.run({
    ...request,
    signal: controller.signal,
    onText: (value) => { text.push(value) },
    onEvent: (event) => {
      observed.push(event)
      if (event.type === 'turn.started')
        started.resolve()
    },
  })
  pending.catch(() => undefined)
  await model.entered
  await started.promise
  // 等创建响应返回，再断网，明确只验证事件恢复而非不确定的写入重试
  await vi.waitFor(() => {
    expect(admissionReturned).toBe(true)
    expect(harness.events.some(event => event.type === 'turn.started' && event.turnId === request.turnId)).toBe(true)
  })
  await listener.close()
  await vi.waitFor(() => expect(subscriptions.length).toBeGreaterThan(1))
  expect(subscriptions[1]?.headers.get('last-event-id')).toBeTruthy()
  expect(model.signal?.aborted).toBe(false)
  if (replaceServer) {
    await harness.server.close()
    // 只更换传输层：借用同一个 Elmino，模型、Store 和执行身份都不变
    replacement = defineServer({ elmino: harness.elmino, apiKey: null, corsOrigins: [] })
  }
  model.release()
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  expect(observed.some(event => event.type === 'turn.completed')).toBe(false)
  listener = await listen({ server: replacement ?? harness.server, port })
  const result = await pending

  expect(result).toMatchObject({ threadId: request.threadId, turnId: request.turnId, status: 'completed' })
  expect(text.join('')).toBe('断线期间完成的唯一回复')
  expect(model.requests).toHaveLength(1)
  expect(harness.modelRequests).toHaveLength(1)
  expect(await harness.stores.primary.store.turns.list(request.threadId)).toHaveLength(1)
  expect(new Set(observed.map(event => event.id)).size).toBe(observed.length)
  expect(harness.events.filter(event => event.type === 'turn.completed' && event.turnId === request.turnId)).toHaveLength(1)
  expect(harness.errors).toEqual([])
}, 15_000)
