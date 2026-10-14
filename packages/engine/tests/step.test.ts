import type { Message, ModelTurnConfig, Provider, Request, Result, TurnModel, Usage } from '@elmino/llm'
import type { RuntimeStore } from '@elmino/store'
import type { RuntimeEvent, ThreadUsagePayload } from '@elmino/thread'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ObjectParseError } from '@elmino/llm'
import { estimateTokens } from '@elmino/loop'
import { createId, delay } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { expect, test } from 'vitest'
import { createTrackedTurnModel } from '../src/engine/step'
import { getBuiltinSubagentRoles } from '../src/subagent/roles'
import { testFiles } from './support/files'

const testSubagentRoles = getBuiltinSubagentRoles()
const testSubagentRole = testSubagentRoles[0]!

/** -------------------- 常量 -------------------- */
/** Step 测试使用的冻结模型配置 */
const modelConfig = {
  id: 'model_4c9d83a5-9ff6-439a-b264-68fd4bec0355',
  providerId: 'provider_11da3428-7354-4536-918d-09c6caf6bc70',
  providerName: 'anthropic',
  name: 'test-model',
  label: 'Test Model',
  apiFormat: 'anthropic-messages',
  baseURL: 'https://example.com/anthropic',
  cache: { mode: 'disabled' },
  limit: { context: 100_000 },
  jsonSchema: true,
  inputModalities: [] as ModelTurnConfig['inputModalities'],
} as const
/** 测试 Provider 的完整零用量 */
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheWrite: 0,
  cacheRead: 0,
}

/** -------------------- 测试 -------------------- */
test('tracked model records normalized provider usage and does not count token probes as steps', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_usage_fields', 'turn_usage_fields')
    let countCalls = 0
    const provider = createProvider({
      countTokens() {
        expect(this).toBe(provider)
        countCalls += 1
        return Promise.resolve(42)
      },
      generate: () => Promise.resolve(result('完整用量', {
        input: 10,
        output: 5,
        reasoning: 1,
        cacheWrite: 2,
        cacheRead: 3,
      })),
    })
    const events: RuntimeEvent[] = []
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_usage_fields',
      threadId: 'thread_usage_fields',
      store: context.store,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    })
    const request = textRequest('只测量，不生成')

    expect(await model.adapter.countTokens?.({
      messages: request.messages,
      system: request.system,
      tools: request.tools,
    })).toBe(42)
    expect(await context.store.steps.list('turn_usage_fields')).toHaveLength(0)

    await model.adapter.generate(textRequest('完整字段'))

    expect(countCalls).toBe(1)
    expect(await context.store.steps.list('turn_usage_fields')).toEqual([
      expect.objectContaining({
        status: 'completed',
        input: 10,
        output: 5,
        reasoning: 1,
        cacheWrite: 2,
        cacheRead: 3,
        estimated: 0,
      }),
    ])
    expect(events.filter(event => event.type === 'token.usage')).toHaveLength(1)
  }
  finally {
    await disposeStepStore(context)
  }
})

test('tracked model estimates completed usage when provider omits usage', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_estimated_usage', 'turn_estimated_usage')
    const provider = createProvider({
      generate: () => Promise.resolve(result('本地估算输出', EMPTY_USAGE)),
    })
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_estimated_usage',
      threadId: 'thread_estimated_usage',
      store: context.store,
    })

    expect(model.adapter.countTokens).toBeUndefined()
    await model.adapter.generate(textRequest('兼容服务没有返回 usage'))

    const [step] = await context.store.steps.list('turn_estimated_usage')

    expect(step).toMatchObject({
      status: 'completed',
      reasoning: 0,
      cacheWrite: 0,
      cacheRead: 0,
    })
    expect(step?.input).toBeGreaterThan(0)
    expect(step?.output).toBeGreaterThan(0)
    expect(step?.estimated).toBe((step?.input ?? 0) + (step?.output ?? 0))
  }
  finally {
    await disposeStepStore(context)
  }
})

test('tracked stream settles interrupted output from usage events and received deltas', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_stream', 'turn_stream')
    const controller = new AbortController()
    const partialText = '中断前已经收到的流式内容'.repeat(20)
    const provider = createProvider({
      stream: async (_request, onEvent) => {
        await onEvent?.({
          type: 'usage',
          usage: { ...EMPTY_USAGE, input: 10, output: 2, cacheWrite: 1, cacheRead: 1 },
        })
        await onEvent?.({
          type: 'part-delta',
          index: 0,
          delta: { type: 'text', text: partialText },
        })
        controller.abort('用户中断')
        throw new Error('流式连接已中断')
      },
    })
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_stream',
      threadId: 'thread_stream',
      store: context.store,
    })

    await expect(model.adapter.stream({
      ...textRequest('开始流式生成'),
      signal: controller.signal,
    })).rejects.toThrow('流式连接已中断')

    const [step] = await context.store.steps.list('turn_stream')
    const localOutput = estimateTokens(partialText).tokens

    expect(step).toMatchObject({
      status: 'interrupted',
      input: 10,
      output: localOutput,
      cacheWrite: 1,
      cacheRead: 1,
      estimated: localOutput - 2,
    })
  }
  finally {
    await disposeStepStore(context)
  }
})

test('tracked stream does not double count completed tool args after deltas', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_tool_stream', 'turn_tool_stream')
    const controller = new AbortController()
    const tool = {
      type: 'tool-call' as const,
      id: 'call_stream',
      name: 'weather',
      args: { city: '杭州' },
      argsText: '{"city":"杭州"}',
    }
    const provider = createProvider({
      stream: async (_request, onEvent) => {
        await onEvent?.({
          type: 'part-delta',
          index: 0,
          delta: { type: 'tool-args', text: '{"city":' },
        })
        await onEvent?.({
          type: 'part-delta',
          index: 0,
          delta: { type: 'tool-args', text: '"杭州"}' },
        })
        await onEvent?.({ type: 'part-end', index: 0, part: tool })
        controller.abort('用户中断')
        throw new Error('工具流已中断')
      },
    })
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_tool_stream',
      threadId: 'thread_tool_stream',
      store: context.store,
    })

    await expect(model.adapter.stream({
      ...textRequest('调用工具'),
      signal: controller.signal,
    })).rejects.toThrow('工具流已中断')

    const [step] = await context.store.steps.list('turn_tool_stream')
    const estimatedOutput = estimateTokens(JSON.stringify(tool)).tokens

    expect(step).toMatchObject({
      status: 'interrupted',
      output: estimatedOutput,
      estimated: (step?.input ?? 0) + estimatedOutput,
    })
  }
  finally {
    await disposeStepStore(context)
  }
})

test('tracked request and object parsing failures settle without losing completed usage', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_object', 'turn_object')
    const parseResult = result('{"invalid":true}', {
      ...EMPTY_USAGE,
      input: 12,
      output: 4,
      cacheRead: 6,
    })
    const provider = createProvider({
      generate: () => Promise.reject(new Error('The operation was aborted.')),
      generateObject: (() => Promise.reject(
        new ObjectParseError(parseResult, new Error('结构化校验失败')),
      )) as Provider['generateObject'],
    })
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_object',
      threadId: 'thread_object',
      store: context.store,
    })

    await expect(model.adapter.generate(textRequest('响应前失败')))
      .rejects
      .toThrow('The operation was aborted.')
    await expect(model.adapter.generateObject({
      ...textRequest('返回对象'),
      schema: { parse: () => ({}) } as never,
    })).rejects.toThrow('结构化校验失败')

    const steps = await context.store.steps.list('turn_object')
    const failedRequest = steps.find(step => step.cacheRead === 0)
    const parseFailure = steps.find(step => step.cacheRead === 6)

    expect(failedRequest).toMatchObject({ status: 'failed', output: 0, estimated: failedRequest?.input })
    expect(parseFailure).toMatchObject({
      status: 'failed',
      input: 12,
      output: 4,
      cacheRead: 6,
      estimated: 0,
    })
  }
  finally {
    await disposeStepStore(context)
  }
})

test('concurrent steps aggregate independently without lost usage', async () => {
  const context = await createStepStore()

  try {
    await seedTurn(context.store, 'thread_concurrent', 'turn_concurrent')
    const provider = createProvider({
      generate: async () => {
        await delay(5)
        return result('主请求', { ...EMPTY_USAGE, input: 10, output: 2 })
      },
      generateObject: (() => Promise.resolve({
        ...result('{"title":"并发标题"}', { ...EMPTY_USAGE, input: 20, output: 3 }),
        object: { title: '并发标题' },
        text: '{"title":"并发标题"}',
      })) as Provider['generateObject'],
    })
    const model = createTrackedTurnModel({
      model: createTurnModel(provider),
      turnId: 'turn_concurrent',
      threadId: 'thread_concurrent',
      store: context.store,
    })

    await Promise.all([
      model.adapter.generate(textRequest('主请求')),
      model.adapter.generateObject({
        ...textRequest('生成标题'),
        schema: { parse: () => ({ title: '' }) } as never,
      }),
    ])

    expect(await context.store.steps.list('turn_concurrent')).toHaveLength(2)
    expect((await context.store.turns.read('turn_concurrent'))?.usage).toMatchObject({
      input: 30,
      output: 5,
      total: 35,
      estimated: 0,
    })
  }
  finally {
    await disposeStepStore(context)
  }
})

test('task usage recursively includes descendants once and keeps own usage isolated', async () => {
  const context = await createStepStore()

  try {
    for (const [threadId, turnId] of [
      ['thread_parent', 'turn_parent'],
      ['thread_child', 'turn_child'],
      ['thread_grandchild', 'turn_grandchild'],
    ] as const) {
      await seedTurn(context.store, threadId, turnId)
    }
    await context.store.spawnEdges.create({
      ownerId: 'subagent',
      parentThreadId: 'thread_parent',
      childThreadId: 'thread_child',
    })
    await context.store.spawnEdges.create({
      ownerId: 'subagent',
      parentThreadId: 'thread_child',
      childThreadId: 'thread_grandchild',
    })
    await settleUsage(context.store, 'turn_parent', 2)
    await settleUsage(context.store, 'turn_child', 3)
    const events: RuntimeEvent[] = []
    const model = createTrackedTurnModel({
      model: createTurnModel(createProvider({
        generate: () => Promise.resolve(result('孙任务完成', { ...EMPTY_USAGE, input: 5 })),
      })),
      turnId: 'turn_grandchild',
      threadId: 'thread_grandchild',
      store: context.store,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    })

    await model.adapter.generate(textRequest('完成孙任务'))

    const usages = new Map(events
      .filter(event => event.type === 'token.usage')
      .map(event => [event.threadId, event.payload as ThreadUsagePayload]))

    expect(usages.get('thread_grandchild')).toMatchObject({ usage: { total: 5 }, taskUsage: { total: 5 } })
    expect(usages.get('thread_child')).toMatchObject({ usage: { total: 3 }, taskUsage: { total: 8 } })
    expect(usages.get('thread_parent')).toMatchObject({ usage: { total: 2 }, taskUsage: { total: 10 } })
  }
  finally {
    await disposeStepStore(context)
  }
})

/** -------------------- 辅助函数 -------------------- */
/**
 * 创建只覆盖当前测试行为的 Provider
 */
function createProvider(overrides: Partial<Provider>): Provider {
  const unsupported = () => Promise.reject(new Error('测试未实现该生成方式'))

  return {
    name: 'test',
    model: 'test-model',
    capabilities: {
      cache: { modes: ['disabled'] },
      reasoning: true,
      tools: true,
      jsonSchema: true,
    },
    generate: unsupported as Provider['generate'],
    stream: unsupported as Provider['stream'],
    generateObject: unsupported as Provider['generateObject'],
    ...overrides,
  }
}

/**
 * 创建绑定测试 Provider 的冻结模型
 */
function createTurnModel(adapter: Provider): TurnModel<typeof modelConfig> {
  return { config: modelConfig, adapter }
}

/**
 * 创建公共 assistant 响应
 */
function createMessage(text: string): Message {
  return {
    id: createId('message'),
    role: 'assistant',
    parts: [{ type: 'text', text }],
    finishReason: 'completed',
    rawFinishReason: 'end_turn',
  }
}

/**
 * 创建完整 Provider 结果
 */
function result(text: string, usage: Usage): Result {
  return { message: createMessage(text), usage }
}

/**
 * 创建固定文本请求
 */
function textRequest(content: string): Request {
  return {
    system: [],
    messages: [{ role: 'user', parts: [{ type: 'text', text: content }] }],
    maxOutputTokens: 64,
    cache: { mode: 'disabled' },
  }
}

/**
 * 创建独立 RuntimeStore
 */
async function createStepStore(): Promise<{ root: string, store: RuntimeStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-step-'))
  const store = await SqliteStore.create({
    dataDir: path.join(root, 'db'),
    blobStore: LocalBlobStore.create({
      files: testFiles,
      rootDir: path.join(root, 'blobs'),
    }),
  })

  return { root, store }
}

/**
 * 关闭独立 RuntimeStore 并清理测试目录
 */
async function disposeStepStore(context: { root: string, store: RuntimeStore }) {
  await context.store.close()
  await rm(context.root, { force: true, recursive: true })
}

/**
 * 创建 Step 所属线程和 Turn
 */
async function seedTurn(store: RuntimeStore, threadId: string, turnId: string) {
  await store.threads.upsert({ dir: '.', agentId: 'code', id: threadId, status: 'running' })
  await store.turns.create({
    id: turnId,
    threadId,
    status: 'running',
    modelConfig: { ...modelConfig },
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'auto',
    subagentMode: 'explicitOnly',
  })
}

/**
 * 写入一条已完成的固定用量 Step
 */
async function settleUsage(store: RuntimeStore, turnId: string, input: number) {
  const step = await store.steps.create({ turnId, input, estimated: 0 })

  await store.steps.settle(step.id, {
    status: 'completed',
    input,
    output: 0,
    reasoning: 0,
    cacheWrite: 0,
    cacheRead: 0,
    estimated: 0,
  })
}
