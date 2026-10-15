import type { Runtime } from '@elmino/runtime'
import type { RuntimeStoreProvider } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import type { DefinedTools } from '@elmino/tool'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine, runAgent } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { createEngineStore, createTestRuntime, disposeEngineStore } from './support/engine'
import { createModel, response } from './support/model'

/** 用真实存储与 Runtime 核对单次入口的所有权和持久化结果 */
async function createRunHarness(tools?: DefinedTools, closeError?: Error) {
  const { root, store } = await createEngineStore()
  const runtimes: Runtime[] = []
  const disposals: ReturnType<typeof vi.fn>[] = []
  const agent = defineAgent({
    id: 'writer',
    systemPrompt: '按用户要求完成任务',
    tools,
    runtime: {
      create: ({ location }) => {
        const runtime = createTestRuntime(location)
        runtimes.push(runtime)
        const dispose = vi.fn(async () => {
          await runtime.dispose()
          if (closeError)
            throw closeError
        })
        disposals.push(dispose)
        return { location, sandbox: () => runtime.sandbox(), dispose }
      },
    },
  })
  onTestFinished(() => disposeEngineStore(root, store))
  return { root, store, agent, runtimes, disposals }
}

test('单次入口接收文本，执行真实工具并返回持久化身份，返回前已释放 Runtime', async () => {
  const tools = defineTools({
    save: {
      description: '保存任务结果',
      schema: z.object({ text: z.string() }),
      execute: async ({ text }, { sandbox }) => {
        const result = await sandbox.files.write('result.txt', text)
        if (result.error)
          throw new Error(result.error)
        return text
      },
    },
  })
  const harness = await createRunHarness(tools)
  const model = createModel([
    response([{ type: 'tool-call', id: 'save_result', name: 'save', args: { text: 'Hello from elmino' } }], 'tool-calls'),
    response([{ type: 'text', text: '任务完成' }]),
  ])
  const events: RuntimeEvent[] = []
  const result = await runAgent({
    agent: harness.agent,
    model: model.model,
    store: harness.store,
    workspace: { id: 'fixed', rootDir: path.relative(process.cwd(), harness.root) },
    input: '保存任务结果',
    approvalMode: 'fullAccess',
    onRuntimeEvent: (event) => { events.push(event) },
  })
  expect(result.status).toBe('completed')
  expect(result.threadId).toMatch(/^thread_/u)
  expect(result.turnId).toMatch(/^turn_/u)
  expect(result.workspaceId).toBe('fixed')
  expect(extractText(result.message!)).toBe('任务完成')
  expect(await readFile(path.join(harness.root, 'result.txt'), 'utf8')).toBe('Hello from elmino')
  expect(await harness.store.turns.read(result.turnId)).toMatchObject({ threadId: result.threadId, status: 'completed' })
  expect(await harness.store.threads.read(result.threadId)).toMatchObject({ dir: '.', metadata: { workspaceId: result.workspaceId } })
  expect(await harness.store.steps.list(result.turnId)).toHaveLength(2)
  expect(model.requests[0]!.messages.flatMap(message => message.parts)).toContainEqual({ type: 'text', text: '保存任务结果' })
  expect(events.filter(event => event.type === 'turn.completed')).toHaveLength(1)
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  expect(() => harness.runtimes[0]!.sandbox()).toThrow()
})

test('模型失败返回持久化的失败状态与原因并释放 Runtime，宿主仍可读取 Store', async () => {
  const harness = await createRunHarness()
  const failure = new Error('模型调用失败')
  const result = await runAgent({
    agent: harness.agent,
    model: createModel([failure]).model,
    store: harness.store,
    workspace: { id: 'fixed', rootDir: harness.root },
    input: [{ type: 'text', text: '执行任务' }],
  })
  expect(result).toMatchObject({ status: 'failed', errorMessage: failure.message })
  expect(await harness.store.turns.listAll()).toMatchObject([{ status: 'failed', errorMessage: failure.message }])
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  expect(() => harness.runtimes[0]!.sandbox()).toThrow()
})

test('执行器与资源关闭同时失败时聚合两种错误，关闭错误不覆盖执行错误', async () => {
  const closeError = new Error('资源关闭失败')
  const harness = await createRunHarness(undefined, closeError)
  const failure = new Error('模型调用失败')
  const result = runAgent({
    agent: defineAgent({ ...harness.agent, loop: { invoke: () => Promise.reject(failure) } }),
    model: createModel([]).model,
    store: harness.store,
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
  })
  await expect(result).rejects.toMatchObject({ errors: [failure, { errors: [closeError] }] })
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
})

test('审批中断返回 interrupted，关闭单次入口后仍能用原身份恢复工具', async () => {
  const execute = vi.fn(() => '审批后执行')
  const harness = await createRunHarness(defineTools({
    work: { description: '需要审批', schema: z.object({}), approval: 'auto', execute },
  }))
  const model = createModel([response([{ type: 'tool-call', id: 'work_call', name: 'work', args: {} }], 'tool-calls')])
  const result = await runAgent({
    agent: harness.agent,
    model: model.model,
    store: harness.store,
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
    approvalMode: 'request',
  })
  expect(result).toMatchObject({ status: 'interrupted', workspaceId: 'fixed' })
  expect(execute).not.toHaveBeenCalled()
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  const turn = await harness.store.turns.read(result.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(turn?.interrupt))!
  const engine = AgentEngine.create({ writer: harness.agent })
  onTestFinished(() => engine.close())
  const restored = createModel([response([{ type: 'text', text: '已恢复完成' }])])
  const execution = engine.resume({
    agentId: 'writer',
    threadId: result.threadId,
    turnId: result.turnId,
    model: restored.model,
    location: {
      workspaceId: result.workspaceId,
      workspaceKind: 'project',
      workspaceRoot: harness.root,
      cwd: harness.root,
      dir: '.',
    },
    resume: { interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'work_call' }] } },
  }, harness.store)
  expect(extractText((await execution.completed)!)).toBe('已恢复完成')
  expect(execute).toHaveBeenCalledOnce()
  expect(await harness.store.turns.read(result.turnId)).toMatchObject({ status: 'completed' })
  await engine.close()
})

test('外部取消等待模型退出与中断结算后释放 Runtime', async () => {
  const harness = await createRunHarness()
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const failure = new Error('用户取消任务')
  const model = createModel([request => new Promise((_resolve, reject) => {
    request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
    entered.resolve()
  })])
  const result = runAgent({
    agent: harness.agent,
    model: model.model,
    store: harness.store,
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '等待任务',
    signal: controller.signal,
  })
  result.catch(() => undefined)
  await entered.promise
  controller.abort(failure)
  await expect(result).rejects.toBe(failure)
  expect(await harness.store.turns.listAll()).toMatchObject([{ status: 'interrupted' }])
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  expect(() => harness.runtimes[0]!.sandbox()).toThrow()
})

test('等待存储提供者完成借用后才创建 Runtime，关闭 Engine 后释放租约且不关闭宿主 Store', async () => {
  const harness = await createRunHarness()
  const borrowed = Promise.withResolvers<void>()
  const releasing = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const controller = new AbortController()
  const closeStore = vi.spyOn(harness.store, 'close')
  const release = vi.fn(async () => {
    expect(harness.disposals[0]).toHaveBeenCalledOnce()
    expect(() => harness.runtimes[0]!.sandbox()).toThrow()
    releasing.resolve()
    await released.promise
    expect(await harness.store.turns.listAll()).toMatchObject([{ status: 'completed' }])
  })
  const provider = vi.fn<RuntimeStoreProvider>(async () => {
    await borrowed.promise
    return { store: harness.store, release }
  })
  const model = createModel([response([{ type: 'text', text: '已完成' }])])
  const pending = runAgent({
    agent: harness.agent,
    model: model.model,
    store: provider,
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
    signal: controller.signal,
  })
  expect(provider).toHaveBeenCalledExactlyOnceWith(controller.signal)
  expect(harness.runtimes).toHaveLength(0)
  expect(model.requests).toHaveLength(0)
  expect(release).not.toHaveBeenCalled()
  let settled = false
  pending.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  borrowed.resolve()
  await releasing.promise
  expect(settled).toBe(false)
  released.resolve()
  const result = await pending
  expect(result.status).toBe('completed')
  expect(release).toHaveBeenCalledOnce()
  expect(closeStore).not.toHaveBeenCalled()
  expect(await harness.store.turns.read(result.turnId)).toMatchObject({ status: 'completed' })
})

test.each(['failure', 'abort'] as const)('%s 时等待 Runtime 退出后释放存储租约', async (mode) => {
  const harness = await createRunHarness()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  const failure = new Error(mode === 'abort' ? '租约任务被取消' : '租约执行器失败')
  const agent = defineAgent({
    ...harness.agent,
    loop: {
      invoke: context => mode === 'failure'
        ? Promise.reject(failure)
        : new Promise((_resolve, reject) => {
            context.signal!.addEventListener('abort', () => reject(context.signal!.reason), { once: true })
            entered.resolve()
          }),
    },
  })
  const release = vi.fn(async () => {
    expect(harness.disposals[0]).toHaveBeenCalledOnce()
    expect(() => harness.runtimes[0]!.sandbox()).toThrow()
    expect(await harness.store.turns.listAll()).toMatchObject([{ status: mode === 'abort' ? 'interrupted' : 'failed' }])
  })
  const pending = runAgent({
    agent,
    model: createModel([]).model,
    store: () => Promise.resolve({ store: harness.store, release }),
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
    signal: controller.signal,
  })
  const rejected = expect(pending).rejects.toBe(failure)
  if (mode === 'abort') {
    await entered.promise
    expect(release).not.toHaveBeenCalled()
    controller.abort(failure)
  }
  await rejected
  expect(release).toHaveBeenCalledOnce()
  expect(await harness.store.turns.listAll()).toHaveLength(1)
})

test('Engine 初始化失败仍释放已经借到的存储租约', async () => {
  const harness = await createRunHarness()
  const failure = new Error('Engine 初始化失败')
  const release = vi.fn(() => Promise.resolve())
  const create = vi.spyOn(AgentEngine, 'create').mockImplementationOnce(() => {
    throw failure
  })
  try {
    await expect(runAgent({
      agent: harness.agent,
      model: createModel([]).model,
      store: () => Promise.resolve({ store: harness.store, release }),
      workspace: { id: 'fixed', rootDir: harness.root },
      input: '执行任务',
    })).rejects.toBe(failure)
    expect(release).toHaveBeenCalledOnce()
    expect(harness.runtimes).toHaveLength(0)
    expect(await harness.store.turns.listAll()).toEqual([])
  }
  finally {
    create.mockRestore()
  }
})

test('存储提供者打开失败时不创建 Engine，也不清理尚未借到的资源', async () => {
  const harness = await createRunHarness()
  const failure = new Error('存储暂时不可用')
  const create = vi.spyOn(AgentEngine, 'create')
  const closeStore = vi.spyOn(harness.store, 'close')
  const provider: RuntimeStoreProvider = () => Promise.reject(failure)
  try {
    await expect(runAgent({
      agent: harness.agent,
      model: createModel([]).model,
      store: provider,
      workspace: { id: 'fixed', rootDir: harness.root },
      input: '执行任务',
    })).rejects.toBe(failure)
    expect(create).not.toHaveBeenCalled()
    expect(closeStore).not.toHaveBeenCalled()
    expect(await harness.store.turns.listAll()).toEqual([])
  }
  finally {
    create.mockRestore()
  }
})

test.each(['sync', 'async'] as const)('执行、Engine 关闭和 %s 租约释放失败时保留全部原因', async (mode) => {
  const closeError = new Error('Runtime 关闭失败')
  const releaseError = new Error('租约释放失败')
  const failure = new Error('执行器失败')
  const harness = await createRunHarness(undefined, closeError)
  const release = vi.fn(() => {
    if (mode === 'sync')
      throw releaseError
    return Promise.reject(releaseError)
  })
  await expect(runAgent({
    agent: defineAgent({ ...harness.agent, loop: { invoke: () => Promise.reject(failure) } }),
    model: createModel([]).model,
    store: () => Promise.resolve({ store: harness.store, release }),
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
  })).rejects.toMatchObject({ errors: [failure, { errors: [closeError] }, releaseError] })
  expect(release).toHaveBeenCalledOnce()
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  expect(await harness.store.turns.listAll()).toMatchObject([{ status: 'failed' }])
})

test('执行成功但 Engine 关闭和租约释放均失败时仍聚合两种清理错误', async () => {
  const closeError = new Error('完成后 Runtime 关闭失败')
  const releaseError = new Error('完成后租约释放失败')
  const harness = await createRunHarness(undefined, closeError)
  const release = vi.fn(() => Promise.reject(releaseError))
  await expect(runAgent({
    agent: harness.agent,
    model: createModel([response([{ type: 'text', text: '已完成' }])]).model,
    store: () => Promise.resolve({ store: harness.store, release }),
    workspace: { id: 'fixed', rootDir: harness.root },
    input: '执行任务',
  })).rejects.toMatchObject({ errors: [{ errors: [closeError] }, releaseError] })
  expect(release).toHaveBeenCalledOnce()
  expect(harness.disposals[0]).toHaveBeenCalledOnce()
  expect(await harness.store.turns.listAll()).toMatchObject([{ status: 'completed' }])
})
