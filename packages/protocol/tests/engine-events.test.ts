import type { TurnRequest } from '@elmino/engine'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { DefinedTools } from '@elmino/tool'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { createId } from '@elmino/shared'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import {
  createEngineStore,
  createTestRuntime,
  disposeEngineStore,
  turnRequest,
} from '../../engine/tests/support/engine'
import { createModel, response } from '../../engine/tests/support/model'
import { RuntimeEventSchema } from '../src/runtime/schema'
import { parseRuntimeEventJson, serializeRuntimeEvent } from '../src/runtime/serialize'

/** 将真实运行事件送到传输边界，复用 Engine 所属的存储、模型与 Runtime 测试能力 */
async function createScenario(tools?: DefinedTools) {
  const { root, store } = await createEngineStore()
  const agent = defineAgent({
    id: 'protocol-events',
    systemPrompt: '完成当前任务',
    tools,
    runtime: { create: ({ location }) => createTestRuntime(location) },
  })
  let engine = AgentEngine.create({ [agent.id]: agent })
  const events: RuntimeEvent[] = []
  const captureErrors: unknown[] = []
  const request = (model: TurnRequest['model']): TurnRequest => ({
    ...turnRequest(createId('thread'), createId('turn')),
    agentId: agent.id,
    model,
    approvalMode: 'fullAccess',
    input: [{ type: 'text', text: '执行任务' }],
    location: {
      workspaceId: 'protocol-test',
      workspaceKind: 'project',
      workspaceRoot: root,
      cwd: root,
      dir: '.',
    },
    onRuntimeEvent: (event) => {
      try {
        events.push(structuredClone(event))
      }
      catch (cause) {
        captureErrors.push(cause)
      }
    },
  })
  onTestFinished(async () => {
    await engine.close()
    await disposeEngineStore(root, store)
  })
  return {
    store,
    events,
    captureErrors,
    request,
    get engine() { return engine },
    async restartEngine() {
      await engine.close()
      engine = AgentEngine.create({ [agent.id]: agent })
    },
  }
}

/** 观察器只捕获事实；断言在执行结束后运行，避免 Engine 吞掉观察器异常导致假绿 */
function expectRoundtrips(events: RuntimeEvent[], captureErrors: unknown[]) {
  expect(captureErrors).toEqual([])
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    const normalized: unknown = JSON.parse(JSON.stringify(event))
    const validation = RuntimeEventSchema.safeParse(normalized)
    expect(validation.success, `${event.type}: ${JSON.stringify(validation.error?.issues)}`).toBe(true)
    expect(parseRuntimeEventJson(serializeRuntimeEvent(event)), event.type).toEqual(normalized)
  }
}

test('真实两步工具执行产生的消息、增量、用量和终态事件均可传输还原', async () => {
  const scenario = await createScenario(defineTools({
    work: {
      description: '完成工具任务并报告进度',
      schema: z.object({ value: z.string() }),
      execute: async ({ value }, context) => {
        await context.onToolProgress?.('working')
        return value
      },
    },
  }))
  const model = createModel([
    response([
      { type: 'reasoning', text: '先调用工具' },
      { type: 'tool-call', id: 'native_work', name: 'work', args: { value: '工具结果' } },
    ], 'tool-calls'),
    response([{ type: 'text', text: '任务完成' }]),
  ])
  const request = scenario.request(model.model)
  const execution = scenario.engine.run(request, scenario.store)
  await execution.accepted
  expect(extractText((await execution.completed)!)).toBe('任务完成')
  expect(await scenario.store.steps.list(request.turnId)).toHaveLength(2)
  expect(scenario.events.map(event => event.type)).toEqual(expect.arrayContaining([
    'thread.updated',
    'turn.started',
    'message.updated',
    'message.part.updated',
    'message.part.delta',
    'token.usage',
    'context.budget',
    'turn.completed',
  ]))
  expectRoundtrips(scenario.events, scenario.captureErrors)
})

test('真实审批中断及新 Engine 恢复的事件均可传输且不重复执行工具', async () => {
  const execute = vi.fn(({ value }: { value: string }) => value)
  const scenario = await createScenario(defineTools({
    work: { description: '执行需要审批的任务', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }))
  const initial = createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: '已审批' } }], 'tool-calls'),
    new Error('评审模型失败，转人工审批'),
  ])
  const request = { ...scenario.request(initial.model), approvalMode: 'auto' as const }
  const execution = scenario.engine.run(request, scenario.store)
  await execution.accepted
  await execution.completed
  expect(execute).not.toHaveBeenCalled()
  const pending = await scenario.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))!
  expect(pending?.status).toBe('interrupted')
  expect(interrupt.interaction).toBe('tool_approval')
  expect(scenario.events.map(event => event.type)).toContain('turn.interrupted')
  expectRoundtrips(scenario.events, scenario.captureErrors)

  const interruptionEventCount = scenario.events.length
  await scenario.restartEngine()
  const resumed = scenario.engine.resume({
    ...request,
    input: [],
    model: createModel([response([{ type: 'text', text: '恢复完成' }])]).model,
    resume: { interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'native_work' }] } },
  }, scenario.store)
  await resumed.accepted
  expect(extractText((await resumed.completed)!)).toBe('恢复完成')
  expect(execute).toHaveBeenCalledExactlyOnceWith({ value: '已审批' }, expect.anything())
  expect(scenario.events.slice(interruptionEventCount).map(event => event.type)).toContain('turn.completed')
  expectRoundtrips(scenario.events, scenario.captureErrors)
})

test('模型失败后的真实失败事件保持错误事实并可传输还原', async () => {
  const scenario = await createScenario()
  const request = scenario.request(createModel([new Error('model unavailable')]).model)
  const execution = scenario.engine.run(request, scenario.store)
  await execution.accepted
  // Provider 失败由 Loop 归一化为 failed outcome，没有 assistant response；Engine 持久结算后返回 undefined。
  await expect(execution.completed).resolves.toBeUndefined()
  expect(await scenario.store.turns.read(request.turnId)).toMatchObject({
    status: 'failed',
    errorMessage: 'model unavailable',
  })
  expect(await scenario.store.steps.list(request.turnId)).toMatchObject([{ status: 'failed' }])
  expect(scenario.events.filter(event => event.type === 'turn.failed')).toMatchObject([{
    threadId: request.threadId,
    turnId: request.turnId,
    payload: { message: 'model unavailable', prefix: '[Error] Error' },
  }])
  expectRoundtrips(scenario.events, scenario.captureErrors)
})
