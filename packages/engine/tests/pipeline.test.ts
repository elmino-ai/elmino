import type { AgentHooks } from '@elmino/agent'
import type { TurnRequest } from '@elmino/engine'
import type { DefinedTools } from '@elmino/tool'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'
import { createId } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import * as z from 'zod'
import { testFiles } from './support/files.js'
import { createModel, response } from './support/model.js'

/** 以真实默认 Loop、SQLite 和本地执行环境验证公开装配 */
async function createPipeline(tools?: DefinedTools, hooks?: AgentHooks) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-engine-pipeline-'))
  const blobStore = LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') })
  const storage = { dataDir: path.join(root, 'database'), blobStore }
  let store = await SqliteStore.create(storage)
  const runtime = defineRuntime(({ location }) => LocalSandbox.create({
    cwd: location.cwd,
    allowedRoots: [root],
    env: Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    shell: { kind: 'sh', path: '/bin/sh' },
  }))
  const agent = defineAgent({
    id: 'pipeline',
    systemPrompt: '按用户要求完成任务',
    tools,
    hooks,
    runtime,
  })
  let engine = AgentEngine.create({ pipeline: agent })
  const events: string[] = []
  const request = (model: ReturnType<typeof createModel>['model']): TurnRequest => ({
    agentId: agent.id,
    threadId: createId('thread'),
    turnId: createId('turn'),
    location: {
      workspaceId: 'workspace_pipeline',
      workspaceKind: 'project',
      workspaceRoot: root,
      dir: '.',
      cwd: root,
    },
    input: [{ type: 'text', text: '执行当前任务' }],
    approvalMode: 'fullAccess',
    model,
    onRuntimeEvent: (event) => { events.push(event.type) },
  })
  onTestFinished(async () => {
    await engine.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    request,
    events,
    get store() { return store },
    get engine() { return engine },
    async reopen() {
      await engine.close()
      await store.close()
      store = await SqliteStore.create(storage)
      engine = AgentEngine.create({ pipeline: agent })
    },
  }
}

test('公开 Agent 装配执行工具并持久化 Turn、两次 Step、工具结果和产物', async () => {
  let artifactId = ''
  const tools = defineTools({
    save: {
      description: '写入任务结果',
      schema: z.object({ text: z.string() }),
      execute: async ({ text }, { sandbox }) => {
        const written = await sandbox.files.write('result.txt', text)

        if (written.error)
          throw new Error(written.error)
        return `已保存 ${text}`
      },
    },
  })
  const pipeline = await createPipeline(tools, {
    afterTool: async ({ context }) => {
      const contentText = new TextDecoder().decode(await context.services.runtime.sandbox().files.readBytes('result.txt'))
      const artifact = await context.services.store.artifacts.write({ threadId: context.threadId, contentKind: 'text', contentText })
      artifactId = artifact.id
    },
  })
  const model = createModel([
    response([{ type: 'tool-call', id: 'native_save', name: 'save', args: { text: '可复用结果' } }], 'tool-calls'),
    response([{ type: 'text', text: '任务完成' }]),
  ])
  const request = pipeline.request(model.model)
  const execution = pipeline.engine.run(request, pipeline.store)

  await execution.accepted
  expect(extractText((await execution.completed)!)).toBe('任务完成')
  expect(await pipeline.store.turns.read(request.turnId)).toMatchObject({ status: 'completed' })
  expect(await pipeline.store.steps.list(request.turnId)).toHaveLength(2)
  expect(await pipeline.store.toolCalls.list({ turnId: request.turnId })).toMatchObject([
    { providerCallId: 'native_save', status: 'completed' },
  ])
  expect(model.requests[1]!.messages.flatMap(message => message.parts))
    .toContainEqual({ type: 'tool-result', callId: 'native_save', name: 'save', result: '已保存 可复用结果' })
  expect(pipeline.events.filter(type => type === 'turn.completed')).toHaveLength(1)
  await pipeline.reopen()
  expect((await pipeline.store.artifacts.readText(artifactId))?.content).toBe('可复用结果')
  expect(await pipeline.store.turns.read(request.turnId)).toMatchObject({ status: 'completed' })
})

test('审批挂起后关闭并重开，通过同一 Turn 恢复，过期和无效响应不能重复执行工具', async () => {
  const execute = vi.fn(({ value }: { value: string }) => value)
  const resolveInteraction = vi.fn(() => ({ action: 'cancel' as const, response: '不可接管内置审批' }))
  const pipeline = await createPipeline(defineTools({
    work: { description: '执行需要审批的任务', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }), { resolveInteraction })
  const first = createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'approved result' } }], 'tool-calls'),
    new Error('自动评审服务失败'),
  ])
  const request = { ...pipeline.request(first.model), approvalMode: 'auto' as const }
  const initial = pipeline.engine.run(request, pipeline.store)

  await initial.accepted
  await initial.completed
  expect(execute).not.toHaveBeenCalled()
  const pending = await pipeline.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))!
  expect(interrupt.interaction).toBe('tool_approval')
  expect(pending?.status).toBe('interrupted')
  await pipeline.reopen()
  const restored = createModel([response([{ type: 'text', text: '已恢复' }])])
  const resumeRequest: TurnRequest = {
    ...request,
    model: restored.model,
    input: [],
    resume: { interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'other_call' }] } },
  }
  const invalid = pipeline.engine.resume(resumeRequest, pipeline.store)

  await expect(invalid.accepted).rejects.toThrow('无效')
  await expect(invalid.completed).rejects.toThrow('无效')
  expect(resolveInteraction).not.toHaveBeenCalled()
  expect((await pipeline.store.turns.read(request.turnId))?.status).toBe('interrupted')
  expect(execute).not.toHaveBeenCalled()
  resumeRequest.resume!.response = { decisions: [{ type: 'approve', callId: 'native_work' }] }
  const resumed = pipeline.engine.resume(resumeRequest, pipeline.store)

  await resumed.accepted
  expect(extractText((await resumed.completed)!)).toBe('已恢复')
  expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'approved result' }, expect.anything())
  expect((await pipeline.store.steps.list(request.turnId)).map(step => step.status))
    .toEqual(['completed', 'failed', 'completed'])
  const stale = pipeline.engine.resume(resumeRequest, pipeline.store)

  await expect(stale.completed).rejects.toThrow('可恢复状态')
  expect(execute).toHaveBeenCalledTimes(1)
})

test('异步准备前捕获请求快照，调用方变更模型与输入不会改变本轮事实', async () => {
  const pipeline = await createPipeline()
  const model = createModel([response([{ type: 'text', text: 'done' }])])
  const request = pipeline.request(model.model)
  const execution = pipeline.engine.run(request, pipeline.store)

  request.model.config.limit.context = 10
  if (Array.isArray(request.input) && request.input[0]?.type === 'text')
    request.input[0].text = '后续修改'
  await execution.accepted
  await execution.completed
  expect((await pipeline.store.turns.read(request.turnId))?.modelConfig.limit).toEqual({ context: 1_000_000 })
  expect(model.requests[0]!.messages.flatMap(message => message.parts))
    .toContainEqual({ type: 'text', text: '执行当前任务' })
})

test('事件观察者失败不撤销已完成的存储结算', async () => {
  const pipeline = await createPipeline()
  const model = createModel([response([{ type: 'text', text: '完成' }])])
  const request = {
    ...pipeline.request(model.model),
    onRuntimeEvent: () => {
      throw new Error('observer failure')
    },
  }
  const execution = pipeline.engine.run(request, pipeline.store)

  await execution.accepted
  await expect(execution.completed).resolves.toMatchObject({ role: 'assistant' })
  expect((await pipeline.store.turns.read(request.turnId))?.status).toBe('completed')
})

test.each(['resume', 'cancel'] as const)('自定义交互 %s 与扩展状态在同一事务恢复或取消', async (action) => {
  const released = vi.fn()
  const settled = vi.fn()
  const execute = vi.fn(() => '不应执行原处理器')
  const hooks: AgentHooks = {
    onStarted: async (scope) => {
      if (!scope.context.input.resume)
        await scope.updateState('dialog', { awaiting: true })
      return released
    },
    interceptTool: ({ context, part }) => ({
      interrupt: {
        id: createId('interrupt'),
        kind: 'interaction',
        interaction: 'ask_user',
        status: 'pending',
        turnId: context.turnId,
        reason: '等待回答',
        payload: { callId: part.id },
        createdAt: new Date().toISOString(),
        resumableWith: ['interaction'],
      },
    }),
    resolveInteraction: ({ interrupt, response: answer, state }) => {
      expect(state.dialog).toEqual({ awaiting: true })
      if (answer !== 'continue')
        return undefined
      const payload = interrupt.payload as { callId: string }
      return {
        action,
        response: answer,
        toolResult: { callId: payload.callId, output: '用户回答' },
        state: { dialog: { type: 'remove' } },
      }
    },
    settleState: ({ status, state }) => {
      settled(status, state)
      return { dialog: { type: 'remove' } }
    },
  }
  const pipeline = await createPipeline(defineTools({
    ask: { description: '请求用户回答', schema: z.object({}), execute },
  }), hooks)
  const initial = createModel([response([{ type: 'tool-call', id: 'native_question', name: 'ask', args: {} }], 'tool-calls')])
  const request = pipeline.request(initial.model)
  const started = pipeline.engine.run(request, pipeline.store)

  await started.accepted
  await started.completed
  expect(settled).not.toHaveBeenCalled()
  expect(released).toHaveBeenCalledTimes(1)
  const pending = await pipeline.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))!
  const restored = createModel([response([{ type: 'text', text: '处理回答' }])])
  const resumed = pipeline.engine.resume({
    ...request,
    input: [],
    model: restored.model,
    resume: { interruptId: interrupt.id, response: 'continue' },
  }, pipeline.store)

  await resumed.accepted
  await resumed.completed
  expect(execute).not.toHaveBeenCalled()
  expect((await pipeline.store.turns.read(request.turnId))?.status).toBe(action === 'resume' ? 'completed' : 'cancelled')
  expect((await pipeline.store.threads.read(request.threadId))?.state.extensionState).toEqual({})
  expect(settled).toHaveBeenCalledExactlyOnceWith(action === 'resume' ? 'completed' : 'cancelled', {})
  expect(released).toHaveBeenCalledTimes(action === 'resume' ? 2 : 1)
  expect((await pipeline.store.toolCalls.list({ turnId: request.turnId })).every(call => call.status !== 'pending')).toBe(true)
})
