import type { Agent } from '@elmino/agent'
import type { RuntimeStoreProvider } from '@elmino/store'
import type { Elmino, ModelFactory } from '../src/index'
import { defineAgent } from '@elmino/agent'
import { extractText } from '@elmino/llm'
import { createId } from '@elmino/shared'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createEngineStore, createTestRuntime, disposeEngineStore } from '../../engine/tests/support/engine'
import { createModel, response } from '../../engine/tests/support/model'
import { defineElmino } from '../src/index'

/** 使用真实 RuntimeStore，所有模型都由测试确定，不依赖 HTTP 或真实凭据 */
async function createFixture() {
  const { root, store } = await createEngineStore()
  const applications: Elmino[] = []
  onTestFinished(async () => {
    await Promise.allSettled(applications.map(app => app.close()))
    await disposeEngineStore(root, store)
  })
  const writer = defineAgent({ id: 'writer', systemPrompt: '完成任务', runtime: { create: ({ location }) => createTestRuntime(location) } })
  const workspace = { id: 'project', rootDir: root, store }
  return { root, store, writer, workspace, applications }
}

test('Elmino 直接注册、获取并运行 Agent，定义和元数据查询不打开存储或模型', async () => {
  const fixture = await createFixture()
  const model = createModel([response([{ type: 'text', text: '本地完成' }])])
  model.model.config.id = 'primary'
  const factory = vi.fn(() => model.model)
  const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const provider = vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store: fixture.store, release })
  const elmino = defineElmino({ agents: { writer: fixture.writer }, workspace: { ...fixture.workspace, store: provider }, models: { primary: factory } })
  fixture.applications.push(elmino)
  expect(elmino.getAgent('writer')).toBe(fixture.writer)
  elmino.listAgents().pop()
  expect(elmino.getAgent('writer')).toBe(fixture.writer)
  expect(provider).not.toHaveBeenCalled()
  expect(factory).not.toHaveBeenCalled()
  const result = await elmino.run({ agentId: 'writer', input: '完成本地任务' })
  expect(result.status).toBe('completed')
  expect(extractText(result.message!)).toBe('本地完成')
  expect(provider).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
  const closing = elmino.close()
  expect(elmino.close()).toBe(closing)
  await closing
  expect(release).toHaveBeenCalledOnce()
  expect((await fixture.store.turns.read(result.turnId))?.status).toBe('completed')
  await expect(elmino.run({ agentId: 'writer', input: '不能再执行' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})

test('模型选择按本轮覆盖、线程历史、Agent 默认和应用默认生效', async () => {
  const fixture = await createFixture()
  const factories = Object.fromEntries(['primary', 'agent-model', 'override'].map(id => [id, vi.fn(() => {
    const model = createModel([response([{ type: 'text', text: id }])])
    model.model.config.id = id
    return model.model
  })]))
  const specialized = defineAgent({ ...fixture.writer, id: 'specialized', model: 'agent-model' })
  const elmino = defineElmino({
    agents: { writer: fixture.writer, specialized },
    workspace: fixture.workspace,
    models: factories,
    defaults: { model: 'primary' },
  })
  fixture.applications.push(elmino)
  const ordinary = await elmino.run({ agentId: 'writer', input: '使用应用默认' })
  const agent = await elmino.run({ agentId: 'specialized', input: '使用 Agent 默认' })
  const overridden = await elmino.run({ agentId: 'specialized', input: '本轮覆盖', modelId: 'override' })
  const continued = await elmino.run({ agentId: 'specialized', threadId: overridden.threadId, input: '延续线程模型' })
  expect([ordinary, agent, overridden, continued].map(result => extractText(result.message!)))
    .toEqual(['primary', 'agent-model', 'override', 'override'])
})

test('未注册的 Agent 和模型原型键不能进入模型采样，不匹配的注册 ID 明确失败', async () => {
  const fixture = await createFixture()
  const model = createModel([response([{ type: 'text', text: '不应采样' }])])
  const elmino = defineElmino({ agents: { writer: fixture.writer }, workspace: fixture.workspace, models: { primary: model.model } })
  fixture.applications.push(elmino)
  expect(() => elmino.getAgent('constructor')).toThrow('Agent 不存在')
  await expect(elmino.run({ agentId: 'writer', input: '未注册', modelId: 'constructor' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(elmino.run({ agentId: 'writer', input: '配置不匹配' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(model.requests).toHaveLength(0)
})

test('应用重建后按冻结模型键恢复审批，不读取新默认模型，不重复执行工具', async () => {
  const fixture = await createFixture()
  const execute = vi.fn(() => '工作完成')
  const writer: Agent = defineAgent({
    ...fixture.writer,
    tools: defineTools({ work: { description: '审批后执行', schema: z.object({}), approval: 'auto', execute } }),
  })
  const initial = createModel([response([{ type: 'tool-call', id: 'work_call', name: 'work', args: {} }], 'tool-calls')])
  initial.model.config.id = 'original'
  const frozen = structuredClone(initial.model.config)
  const first = defineElmino({ agents: { writer }, workspace: fixture.workspace, models: { original: initial.model }, defaults: { approvalMode: 'request' } })
  fixture.applications.push(first)
  const target = { agentId: 'writer', workspaceId: 'project', threadId: createId('thread'), turnId: createId('turn') }
  await first.createTurn({ ...target, input: [{ type: 'text', text: '执行工具' }] })
  await vi.waitFor(async () => {
    expect((await fixture.store.turns.read(target.turnId))?.status).toBe('interrupted')
  })
  const turn = await fixture.store.turns.read(target.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(turn?.interrupt))!
  await first.close()
  const restored = createModel([response([{ type: 'text', text: '恢复完成' }])])
  Object.assign(restored.model.config, frozen)
  const factory = vi.fn<ModelFactory>(() => restored.model)
  const other = vi.fn(() => {
    throw new Error('恢复不能选择新默认模型')
  })
  const second = defineElmino({ agents: { writer }, workspace: fixture.workspace, models: { original: factory, other }, defaults: { model: 'other' } })
  fixture.applications.push(second)
  await second.resumeTurn({ ...target, interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'work_call' }] } })
  await vi.waitFor(async () => {
    expect((await fixture.store.turns.read(target.turnId))?.status).toBe('completed')
  })
  expect(factory.mock.calls[0]?.[0].frozenConfig).toEqual(frozen)
  expect(other).not.toHaveBeenCalled()
  expect(execute).toHaveBeenCalledOnce()
})

test('关闭等待已进入的动态模型解析，入口退出后才释放租约', async () => {
  const fixture = await createFixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  onTestFinished(() => gate.resolve())
  const model = createModel([response([{ type: 'text', text: '不应采样' }])])
  let signal: AbortSignal | undefined
  const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const elmino = defineElmino({
    agents: { writer: fixture.writer },
    workspace: { ...fixture.workspace, store: vi.fn<RuntimeStoreProvider>().mockResolvedValue({ store: fixture.store, release }) },
    models: async (request) => {
      signal = request.signal
      entered.resolve()
      await gate.promise
      return model.model
    },
  })
  fixture.applications.push(elmino)
  const running = expect(elmino.run({ agentId: 'writer', input: '等待模型解析' })).rejects.toMatchObject({ code: 'CONFLICT' })
  await entered.promise
  const closing = elmino.close()
  await vi.waitFor(() => {
    expect(signal?.aborted).toBe(true)
  })
  expect(release).not.toHaveBeenCalled()
  gate.resolve()
  await running
  await closing
  expect(release).toHaveBeenCalledOnce()
  expect(model.requests).toHaveLength(0)
})

test('本轮取消会通知动态模型工厂，接纳之前取消不生成持久化 Turn', async () => {
  const fixture = await createFixture()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  const elmino = defineElmino({
    agents: { writer: fixture.writer },
    workspace: fixture.workspace,
    models: ({ signal }) => {
      entered.resolve()
      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    },
  })
  fixture.applications.push(elmino)
  const turnId = createId('turn')
  const pending = elmino.run({ agentId: 'writer', turnId, input: '取消解析', signal: controller.signal })
  const running = expect(pending).rejects.toThrow('取消模型解析')
  await entered.promise
  controller.abort(new Error('取消模型解析'))
  await running
  expect(await fixture.store.turns.read(turnId)).toBeUndefined()
  expect(elmino.closed).toBe(false)
})
