import type { Message, ToolResultPart } from '@elmino/llm'
import type { ExecutionHooks } from '@elmino/loop'
import type { JsonValue } from '@elmino/shared'
import { resolveLoopInteraction } from '@elmino/loop'
import { isPlainRecord } from '@elmino/shared'
import { readThreadInteraction, readThreadSnapshot } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import * as z from 'zod'
import { createHarness } from './support/harness'
import { createModel, response } from './support/model'

/** 并行与审批行为共享的真实工具输入约束 */
const schema = z.object({ label: z.string() })

/** 读取已捕获的公开 Provider 消息，用其原始顺序核对结果回放 */
function toolResults(parts: Message['parts']): ToolResultPart[] {
  return parts.filter((part): part is ToolResultPart => part.type === 'tool-result')
}

test('parallel waves overlap while serial tools remain barriers and replay keeps sampling order', async () => {
  const labels = ['first-a', 'first-b', 'barrier', 'second-a', 'second-b']
  const model = createModel([
    response(labels.map((label, index) => ({
      type: 'tool-call',
      id: `call_${index}`,
      name: index === 2 ? 'serial' : 'parallel',
      args: { label },
    })), 'tool-calls'),
    response([{ type: 'text', text: '工具执行完成' }]),
  ])
  const events: string[] = []
  let active = 0
  let maximum = 0
  const tools = defineTools({
    parallel: {
      description: '记录并发顺序',
      schema,
      parallel: true,
      execute: async ({ label }) => {
        events.push(`${label}:start`)
        active++
        maximum = Math.max(maximum, active)
        await new Promise<void>(resolve => setImmediate(resolve))
        active--
        events.push(`${label}:end`)
        return label
      },
    },
    serial: {
      description: '形成串行屏障',
      schema,
      execute: ({ label }) => {
        events.push(`${label}:${active}`)
        return label
      },
    },
  })
  const harness = await createHarness({ model: model.model, tools })
  const result = await harness.invoke()
  const barrier = events.indexOf('barrier:0')

  expect(result.outcome.status).toBe('completed')
  expect(maximum).toBe(2)
  expect(events.indexOf('first-a:end')).toBeLessThan(barrier)
  expect(events.indexOf('first-b:end')).toBeLessThan(barrier)
  expect(events.indexOf('second-a:start')).toBeGreaterThan(barrier)
  expect(events.indexOf('second-b:start')).toBeGreaterThan(barrier)
  expect(toolResults(model.requests[1]!.messages.at(-1)!.parts).map(part => part.callId))
    .toEqual(labels.map((_, index) => `call_${index}`))
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId })).map(call => call.status))
    .toEqual(Array.from({ length: 5 }).fill('completed'))
  // Step 记账由 Engine 的 Provider 包装器持有，直接 Loop 不重复创建记录
  expect(await harness.store.steps.list(harness.turnId)).toHaveLength(0)
})

test('cancellation drains an already started parallel sibling and settles unstarted calls', async () => {
  const controller = new AbortController()
  const siblingStarted = Promise.withResolvers<void>()
  let finished = false
  let laterExecuted = false
  const model = createModel([response([
    { type: 'tool-call', id: 'call_interrupt', name: 'interrupt', args: { label: 'interrupt' } },
    { type: 'tool-call', id: 'call_sibling', name: 'sibling', args: { label: 'sibling' } },
    { type: 'tool-call', id: 'call_later', name: 'later', args: { label: 'later' } },
  ], 'tool-calls')])
  const tools = defineTools({
    interrupt: {
      description: '在兄弟启动后取消',
      schema,
      parallel: true,
      execute: async () => {
        await siblingStarted.promise
        controller.abort(new Error('运行已中断'))
        throw new Error('运行已中断')
      },
    },
    sibling: {
      description: '完成已经开始的调用',
      schema,
      parallel: true,
      execute: async () => {
        siblingStarted.resolve()
        await new Promise<void>(resolve => setImmediate(resolve))
        finished = true
        return 'sibling complete'
      },
    },
    later: {
      description: '取消后不应开始',
      schema,
      execute: () => {
        laterExecuted = true
        return 'unexpected'
      },
    },
  })
  const released = vi.fn()
  const harness = await createHarness({
    model: model.model,
    tools,
    signal: controller.signal,
    hooks: { onStarted: () => released },
  })

  await expect(harness.invoke()).rejects.toThrow('运行已中断')
  expect(finished).toBe(true)
  expect(laterExecuted).toBe(false)
  expect(released).toHaveBeenCalledTimes(1)
  const calls = await harness.store.toolCalls.list({ turnId: harness.turnId })
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call.status !== 'pending' && call.status !== 'running')).toBe(true)
  expect(calls.find(call => call.providerCallId === 'call_later')?.status).toBe('skipped')
  const results = (await harness.store.canonical.listParts(harness.threadId))
    .filter(part => part.type === 'tool-result')
  expect(results).toHaveLength(3)
})

test.each(['approve', 'reject', 'edit', 'respond'] as const)(
  'approval %s resumes the persisted call once and replays its result',
  async (decision) => {
    const model = createModel([
      response([{ type: 'tool-call', id: 'call_approval', name: 'work', args: { label: 'original' } }], 'tool-calls'),
      response([{ type: 'text', text: '审批恢复完成' }]),
    ])
    const executed: string[] = []
    const tools = defineTools({
      work: {
        description: '需人工审批的调用',
        schema,
        approval: 'auto',
        execute: ({ label }) => {
          executed.push(label)
          return label
        },
      },
    })
    const harness = await createHarness({ model: model.model, tools, approvalMode: 'request' })
    const first = await harness.invoke()
    const interrupt = readThreadInteraction(first.outcome.interrupt)
    if (!interrupt)
      throw new Error('缺少权威审批中断')
    expect(interrupt.interaction).toBe('tool_approval')
    expect(executed).toEqual([])
    const input: JsonValue = decision === 'edit'
      ? { type: decision, callId: 'call_approval', editedAction: { name: 'work', args: { label: 'edited' } } }
      : decision === 'respond'
        ? { type: decision, callId: 'call_approval', message: '人工提供结果' }
        : { type: decision, callId: 'call_approval' }
    const normalized = resolveLoopInteraction(interrupt, { decisions: [input] })
    expect(normalized).toBeDefined()
    const result = await harness.invoke({ resume: { interrupt, response: normalized! } })

    expect(result.outcome.status).toBe('completed')
    expect(executed).toEqual(decision === 'approve' ? ['original'] : decision === 'edit' ? ['edited'] : [])
    expect(await harness.store.toolCalls.list({ turnId: harness.turnId })).toHaveLength(1)
    expect(toolResults(model.requests[1]!.messages.at(-1)!.parts)).toHaveLength(1)
  },
)

test('a custom interaction resumes its own result before executing an unresolved sibling', async () => {
  let executed = 0
  const model = createModel([
    response([
      { type: 'tool-call', id: 'call_question', name: 'question', args: { label: 'question' } },
      { type: 'tool-call', id: 'call_work', name: 'work', args: { label: 'work' } },
    ], 'tool-calls'),
    response([{ type: 'text', text: '继续完成' }]),
  ])
  const tools = defineTools({
    question: { description: '由宿主接管的交互', schema, execute: () => 'unexpected' },
    work: {
      description: '尚未执行的兄弟调用',
      schema,
      execute: () => {
        executed++
        return 'work complete'
      },
    },
  })
  const harness = await createHarness({
    model: model.model,
    tools,
    hooks: {
      interceptTool: ({ context, part }) => part.name === 'question'
        ? { interrupt: {
            id: 'interrupt_question',
            kind: 'interaction',
            interaction: 'question',
            status: 'pending',
            turnId: context.turnId,
            reason: '等待回答',
            payload: {},
            createdAt: new Date().toISOString(),
            resumableWith: ['interaction'],
          } }
        : undefined,
    },
  })
  const first = await harness.invoke()
  const interrupt = readThreadInteraction(first.outcome.interrupt)
  if (!interrupt)
    throw new Error('缺少自定义中断')
  expect(executed).toBe(0)
  const result = await harness.invoke({ resume: {
    interrupt,
    response: { answer: 'ok' },
    toolResult: { callId: 'call_question', output: 'answer complete' },
  } })

  expect(result.outcome.status).toBe('completed')
  expect(executed).toBe(1)
  expect(toolResults(model.requests[1]!.messages.at(-1)!.parts).map(part => part.callId))
    .toEqual(['call_question', 'call_work'])
})

test('stable context freezes, dynamic context refreshes and pure processing preserves Canonical facts', async () => {
  let stable = 0
  let dynamic = 0
  const released = vi.fn()
  const model = createModel([
    response([{ type: 'tool-call', id: 'call_context', name: 'work', args: { label: 'context' } }], 'tool-calls'),
    response([{ type: 'text', text: '完成' }]),
  ])
  const lifecycle: string[] = []
  const hooks: ExecutionHooks = {
    onStarted: () => released,
    onLifecycle: (event) => { lifecycle.push(event) },
    promptStable: () => {
      stable++
      return [{ tag: 'stable', content: `stable-${stable}`, format: 'raw' }]
    },
    promptDynamic: () => {
      dynamic++
      return [{ tag: 'dynamic', content: `dynamic-${dynamic}`, format: 'raw' }]
    },
    collectState: () => ({ test: { dynamic } }),
    processMessages: ({ messages }) => messages.map(item => item.message.role === 'user'
      ? { ...item, message: { ...item.message, parts: [{ type: 'text', text: 'processed user input' }] } }
      : item),
  }
  const tools = defineTools({ work: { description: '形成第二次采样', schema, execute: () => 'done' } })
  const harness = await createHarness({ model: model.model, tools, hooks })
  await harness.invoke()

  expect(stable).toBe(1)
  expect(dynamic).toBe(2)
  expect(model.requests.map(request => request.system!.map(part => part.text).join('\n')))
    .toEqual(['base-system\n\nstable-1\n\ndynamic-1', 'base-system\n\nstable-1\n\ndynamic-2'])
  expect(model.requests[0]!.messages[0]!.parts).toEqual([{ type: 'text', text: 'processed user input' }])
  const [user] = await harness.store.canonical.list(harness.threadId)
  const original = await harness.store.canonical.readMessage(harness.threadId, user!.id)
  expect(original?.parts[0]?.content).toMatchObject({ text: '执行当前任务' })
  expect((await readThreadSnapshot(harness.store, harness.threadId, harness.base.location))?.extensionState)
    .toEqual({ test: { dynamic: 2 } })
  expect(released).toHaveBeenCalledTimes(1)
  expect(lifecycle).toEqual([
    'thread.start',
    'turn.start',
    'user.prompt.submit',
    'tool.batch.started',
    'turn.completed',
  ])
})

test('edited arguments are authorized again after beforeTool and cannot expand execution access', async () => {
  let executed = false
  const authorized: string[] = []
  const model = createModel([
    response([{ type: 'tool-call', id: 'call_recheck', name: 'work', args: { label: 'safe' } }], 'tool-calls'),
    response([{ type: 'text', text: '限制已生效' }]),
  ])
  const tools = defineTools({ work: {
    description: '检查参数改写后的授权',
    schema,
    execute: () => {
      executed = true
      return 'unexpected'
    },
  } })
  const harness = await createHarness({
    model: model.model,
    tools,
    hooks: {
      beforeTool: () => ({ updatedArgs: { label: 'blocked' } }),
      authorizeTool: (_tool, args) => {
        if (!isPlainRecord(args) || typeof args.label !== 'string')
          throw new Error('缺少工具输入')
        authorized.push(args.label)
        return args.label === 'blocked' ? '禁止扩大权限' : undefined
      },
    },
  })
  await harness.invoke()

  expect(authorized).toEqual(['safe', 'blocked'])
  expect(executed).toBe(false)
  expect((await harness.store.toolCalls.list({ turnId: harness.turnId }))[0]?.status).toBe('failed')
  expect(toolResults(model.requests[1]!.messages.at(-1)!.parts)[0]).toMatchObject({ error: true })
})

test('Runtime event observer failures do not retry sampling or prevent authoritative commits', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const model = createModel([response([{ type: 'text', text: '完整正文' }])])
  const harness = await createHarness({
    model: model.model,
    onEvent: () => Promise.reject(new Error('observer unavailable')),
  })
  try {
    expect((await harness.invoke()).outcome.status).toBe('completed')
    expect(model.requests).toHaveLength(1)
    expect(await harness.store.transcript.list(harness.threadId)).toHaveLength(1)
    expect(harness.events.some(event => event.type === 'message.part.delta')).toBe(true)
    expect(warning).toHaveBeenCalled()
  }
  finally {
    warning.mockRestore()
  }
})
