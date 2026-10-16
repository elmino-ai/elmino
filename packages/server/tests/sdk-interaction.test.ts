import type { ThreadState } from '@elmino/thread'
import { setImmediate } from 'node:timers/promises'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { createServerHarness } from './support/server'

/** 审批经过真实模型暂停、SDK 交互快照、Server 恢复与工具执行，始终沿用原 Turn */
test.each(['approve', 'resume'] as const)('%s 恢复同一 Turn，只展示恢复后的输出，旧审批再次使用返回冲突', async (method) => {
  const execute = vi.fn(({ value }: { value: string }) => `result:${value}`)
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需要确认的工作', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  const initial = createModel([
    response([
      { type: 'reasoning', text: '审批前的思考' },
      { type: 'text', text: '审批前的解释' },
      { type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'approved' } },
    ], 'tool-calls'),
    new Error('转为人工确认'),
  ])
  harness.models.push(initial.model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const pending = await thread.run('执行工作', { approvalMode: 'auto', signal: AbortSignal.timeout(5_000) })
  expect(pending.status).toBe('interrupted')
  const interaction = pending.interaction!
  expect(interaction).toMatchObject({
    agentId: thread.agentId,
    workspaceId: thread.workspaceId,
    threadId: thread.threadId,
    turnId: pending.turnId,
    interruptId: interaction.interrupt.id,
    approval: { actionRequests: [{ callId: 'native_work', name: 'work', args: { value: 'approved' } }] },
  })
  expect(execute).not.toHaveBeenCalled()
  const restored = createModel([response([
    { type: 'reasoning', text: '恢复后的思考' },
    { type: 'text', text: '恢复完成' },
  ])])
  harness.models.push(restored.model)
  const text: string[] = []
  const reasoning: string[] = []
  const options = {
    signal: AbortSignal.timeout(5_000),
    onText: (value: string) => { text.push(value) },
    onReasoning: (value: string) => { reasoning.push(value) },
  }
  const result = method === 'approve'
    ? await thread.approve(interaction, options)
    : await thread.resume(interaction, { decisions: [{ type: 'approve', callId: 'native_work' }] }, options)
  expect(result).toMatchObject({ turnId: pending.turnId, threadId: pending.threadId, status: 'completed' })
  expect(result.interaction).toBeUndefined()
  expect(result.thread.turns).toHaveLength(1)
  expect(text.join('')).toBe('恢复完成')
  expect(reasoning.join('')).toBe('恢复后的思考')
  expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'approved' }, expect.anything())
  expect(restored.requests).toHaveLength(1)
  expect(harness.modelRequests.at(-1)?.frozenConfig).toEqual(initial.model.config)
  await expect(thread.approve(interaction, { signal: AbortSignal.timeout(5_000) })).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(await harness.stores.primary.store.turns.list(thread.threadId)).toHaveLength(1)
}, 10_000)

test('reject 只拒绝待审批工具，模型仍在原 Turn 继续解释', async () => {
  const execute = vi.fn()
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需要确认的工作', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([{ type: 'tool-call', id: 'native_rejected', name: 'work', args: { value: 'blocked' } }], 'tool-calls'),
    new Error('需要人工确认'),
  ]).model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const pending = await thread.run('执行工作', { approvalMode: 'auto', signal: AbortSignal.timeout(5_000) })
  const restored = createModel([response([{ type: 'text', text: '已尊重拒绝决定，说明其他做法' }])])
  harness.models.push(restored.model)
  const result = await thread.reject(pending.interaction!, '用户不同意执行', { signal: AbortSignal.timeout(5_000) })
  expect(result).toMatchObject({ turnId: pending.turnId, status: 'completed' })
  expect(execute).not.toHaveBeenCalled()
  expect(restored.requests).toHaveLength(1)
  expect(result.thread.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({
    type: 'tool',
    providerCallId: 'native_rejected',
    output: '用户不同意执行',
  }))
  expect(result.thread.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({
    type: 'text',
    text: '已尊重拒绝决定，说明其他做法',
  }))
  expect(harness.events.some(event => event.type === 'turn.cancelled' && event.turnId === pending.turnId)).toBe(false)
}, 10_000)

test('respond 必须完整覆盖当前批次，混合批准、编辑、拒绝和人工结果仅执行相应工具', async () => {
  const execute = vi.fn(({ value }: { value: string }) => `executed:${value}`)
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '等待人工决策', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([
      { type: 'tool-call', id: 'native_approve', name: 'work', args: { value: 'original-approved' } },
      { type: 'tool-call', id: 'native_edit', name: 'work', args: { value: 'original-edited' } },
      { type: 'tool-call', id: 'native_reject', name: 'work', args: { value: 'original-rejected' } },
      { type: 'tool-call', id: 'native_respond', name: 'work', args: { value: 'original-manual' } },
    ], 'tool-calls'),
    new Error('整批需要人工确认'),
  ]).model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const pending = await thread.run('批量执行', { approvalMode: 'auto', signal: AbortSignal.timeout(5_000) })
  const interaction = pending.interaction!
  expect(interaction.approval?.actionRequests).toHaveLength(4)
  await expect(thread.respond(interaction, [{ type: 'approve', callId: 'native_approve' }])).rejects.toBeInstanceOf(TypeError)
  expect(execute).not.toHaveBeenCalled()
  expect(harness.modelRequests).toHaveLength(1)
  const restored = createModel([response([{ type: 'text', text: '已按逐项决策处理' }])])
  harness.models.push(restored.model)
  const result = await thread.respond(interaction, [
    { type: 'approve', callId: 'native_approve' },
    { type: 'edit', callId: 'native_edit', editedAction: { name: 'work', args: { value: 'changed-by-user' } } },
    { type: 'reject', callId: 'native_reject', message: '取消此工具' },
    { type: 'respond', callId: 'native_respond', message: '人工提供的结果' },
  ], { signal: AbortSignal.timeout(5_000) })
  expect(result).toMatchObject({ status: 'completed', turnId: pending.turnId })
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute).toHaveBeenCalledWith({ value: 'original-approved' }, expect.anything())
  expect(execute).toHaveBeenCalledWith({ value: 'changed-by-user' }, expect.anything())
  const tools = result.thread.messages.flatMap(message => message.parts).filter(part => part.type === 'tool')
  expect(tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerCallId: 'native_approve', output: 'executed:original-approved' }),
    expect.objectContaining({ providerCallId: 'native_edit', output: 'executed:changed-by-user' }),
    expect.objectContaining({ providerCallId: 'native_reject', output: '取消此工具' }),
    expect.objectContaining({ providerCallId: 'native_respond', output: '人工提供的结果' }),
  ]))
  expect(restored.requests[0]?.messages.flatMap(message => message.parts)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'tool-result', callId: 'native_respond', result: '人工提供的结果' }),
  ]))
}, 10_000)

test('Server 重启后新 Client 通过 get 和 watch 恢复待审批任务，cancel 不调用模型或执行工具', async () => {
  const execute = vi.fn()
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需人工确认的工作', schema: z.object({}), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([{ type: 'tool-call', id: 'native_pending', name: 'work', args: {} }], 'tool-calls'),
    new Error('需人工确认'),
  ]).model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const pending = await thread.run('稍后处理审批', { approvalMode: 'auto', signal: AbortSignal.timeout(5_000) })
  await harness.restart()
  const client = harness.client()
  const recovered = client.thread({ agentId: thread.agentId, workspaceId: thread.workspaceId, threadId: thread.threadId })
  const snapshot = await recovered.get()
  expect(snapshot.runtime.interrupt).toMatchObject({ id: pending.interaction!.interruptId, status: 'pending' })
  const observed: ThreadState[] = []
  const errors: unknown[] = []
  const stop = recovered.watch((state) => {
    observed.push(state)
  }, {
    signal: AbortSignal.timeout(5_000),
    onError: (error) => { errors.push(error) },
  })
  onTestFinished(stop)
  await vi.waitFor(() => {
    expect(observed.at(-1)?.runtime.interrupt?.id).toBe(pending.interaction!.interruptId)
  })
  const attached = await recovered.attach(pending.turnId, { signal: AbortSignal.timeout(5_000) }).completed
  expect(attached.interaction).toEqual(pending.interaction)
  const result = await recovered.cancel(attached.interaction!, '取消整个任务')
  expect(result).toMatchObject({ threadId: thread.threadId, turnId: pending.turnId, status: 'cancelled' })
  expect(result.interaction).toBeUndefined()
  expect(result.thread.runtime.interrupt).toBeUndefined()
  await vi.waitFor(() => expect(observed.at(-1)?.turns.find(turn => turn.id === pending.turnId)?.status).toBe('cancelled'))
  expect(observed.at(-1)?.runtime.interrupt).toBeUndefined()
  expect(execute).not.toHaveBeenCalled()
  expect(harness.modelRequests).toHaveLength(1)
  expect(errors).toEqual([])
  await expect(recovered.approve(attached.interaction!, { signal: AbortSignal.timeout(5_000) })).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(recovered.cancel(attached.interaction!)).rejects.toMatchObject({ code: 'CONFLICT' })
}, 10_000)

test('watch 的异步监听器可以直接等待同一工作区的 approve，不锁住共享事件来源', async () => {
  const execute = vi.fn(() => '已执行')
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '等待审批', schema: z.object({}), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([{ type: 'tool-call', id: 'native_watch', name: 'work', args: {} }], 'tool-calls'),
  ]).model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const pending = await thread.run('监听器内批准', { approvalMode: 'request', signal: AbortSignal.timeout(4_000) })
  harness.models.push(createModel([response([{ type: 'text', text: '监听器批准后完成' }])]).model)
  const approved = Promise.withResolvers<void>()
  const errors: unknown[] = []
  const states: ThreadState[] = []
  let handled = false
  const stop = thread.watch(async (state) => {
    states.push(state)
    if (handled || state.runtime.interrupt?.id !== pending.interaction!.interruptId)
      return
    handled = true
    try {
      const result = await thread.approve(pending.interaction!, { signal: AbortSignal.timeout(4_000) })
      expect(result.status).toBe('completed')
      approved.resolve()
    }
    catch (error) {
      approved.reject(error)
    }
  }, {
    signal: AbortSignal.timeout(5_000),
    onError: (error) => {
      errors.push(error)
      approved.reject(error)
    },
  })
  onTestFinished(stop)
  await approved.promise
  await vi.waitFor(() => {
    expect(states.at(-1)?.turns.find(turn => turn.id === pending.turnId)?.status).toBe('completed')
  })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(errors).toEqual([])
  expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/events/subscribe'))).toHaveLength(2)
  expect(await harness.stores.primary.store.turns.list(thread.threadId)).toHaveLength(1)
}, 8_000)

test('同一 Turn 两次审批后恢复，重放第一次中断不能提前结束第二次恢复或重发旧内容', async () => {
  const execute = vi.fn(({ value }: { value: string }) => `result:${value}`)
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '逐步审批', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([
      { type: 'text', text: '第一阶段说明' },
      { type: 'tool-call', id: 'native_first', name: 'work', args: { value: 'first' } },
    ], 'tool-calls'),
  ]).model)
  const client = harness.client()
  const thread = client.thread({ agentId: 'alpha', workspaceId: 'primary' })
  const first = await thread.run('两次审批', { approvalMode: 'request', signal: AbortSignal.timeout(5_000) })
  const historical = harness.events.find(event => event.type === 'turn.interrupted' && event.turnId === first.turnId)!
  harness.models.push(createModel([
    response([
      { type: 'text', text: '第二阶段说明' },
      { type: 'tool-call', id: 'native_second', name: 'work', args: { value: 'second' } },
    ], 'tool-calls'),
  ]).model)
  const middleText: string[] = []
  const middleTools: string[] = []
  const second = await thread.approve(first.interaction!, {
    signal: AbortSignal.timeout(5_000),
    onText: (text) => { middleText.push(text) },
    onToolResult: (part) => { middleTools.push(part.providerCallId!) },
  })
  expect(second.status).toBe('interrupted')
  expect(second.interaction!.interruptId).not.toBe(first.interaction!.interruptId)
  expect(second.turnId).toBe(first.turnId)
  expect(middleText.join('')).toBe('第二阶段说明')
  expect(middleTools).toEqual(['native_first'])

  // 模拟 SSE 重投递真实的旧终态；新恢复期间模型保持阻塞，不能把它当作新结束信号
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  onTestFinished(() => proceed.resolve())
  harness.models.push(createModel([async () => {
    entered.resolve()
    await proceed.promise
    return response([{ type: 'text', text: '最终阶段完成' }])
  }]).model)
  const subscribe = client.subscribe.bind(client)
  let replayed = false
  const replay = vi.spyOn(client, 'subscribe').mockImplementation((target, handlers) => subscribe(target, {
    ...handlers,
    async onEvent(event) {
      if (!replayed && event.type === 'turn.started' && event.turnId === first.turnId) {
        replayed = true
        await handlers.onEvent(historical)
      }
      await handlers.onEvent(event)
    },
  }))
  onTestFinished(() => replay.mockRestore())
  const text: string[] = []
  const tools: string[] = []
  const completed = thread.approve(second.interaction!, {
    signal: AbortSignal.timeout(5_000),
    onText: (value) => { text.push(value) },
    onToolResult: (part) => { tools.push(part.providerCallId!) },
  })
  let settled = false
  completed.then(
    () => { settled = true },
    () => { settled = true },
  )
  try {
    await Promise.race([entered.promise, completed])
    await vi.waitFor(() => expect(replayed).toBe(true))
    // 给同进程 Fetch 和事件处理链一次完整的微任务清算；教学模型仍由门控阻塞
    await setImmediate()
    expect(settled).toBe(false)
    expect(text).toEqual([])
    expect(tools).toEqual(['native_second'])
    proceed.resolve()
    const result = await completed
    expect(result.status).toBe('completed')
    expect(result.turnId).toBe(first.turnId)
    expect(result.interaction).toBeUndefined()
    expect(result.thread.turns).toHaveLength(1)
    expect(text.join('')).toBe('最终阶段完成')
    expect(tools).toEqual(['native_second'])
    expect(execute.mock.calls.map(([args]) => args.value)).toEqual(['first', 'second'])
  }
  finally {
    proceed.resolve()
  }
}, 10_000)
