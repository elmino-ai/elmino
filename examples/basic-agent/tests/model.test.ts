import type { Event, Request } from '@elmino/llm'
import { extractText } from '@elmino/llm'
import { ResponsesProvider } from '@elmino/llm-openai/responses'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as z from 'zod'
import { createModelConfig, restoreExampleModel } from '../src/model/model'

/** 工具声明和用户输入由真实公共请求协议表达 */
const request: Request = {
  system: [],
  messages: [{ role: 'user', parts: [{ type: 'text', text: '写入一条笔记' }] }],
  tools: [{ name: 'write_note', schema: { type: 'object', properties: { text: { type: 'string' } } } }],
  maxOutputTokens: 128,
}

beforeEach(() => {
  vi.stubEnv('ELMINO_EXAMPLE_API_KEY', undefined)
  vi.stubEnv('ELMINO_EXAMPLE_MODEL', undefined)
  vi.stubEnv('ELMINO_EXAMPLE_BASE_URL', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test.each([false, true])('demo 无凭据完成工具采样和结果回放，工具失败=%s', async (error) => {
  const { adapter } = restoreExampleModel({ ...createModelConfig('demo') })
  const events: Event[] = []
  const first = await adapter.stream(request, (event) => {
    events.push(event)
  })
  const call = first.message.parts[0]

  expect(adapter.name).toBe('demo')
  expect(first.message.finishReason).toBe('tool-calls')
  expect(call).toMatchObject({ type: 'tool-call', name: 'write_note', args: { text: 'Hello from elmino' } })
  if (call?.type !== 'tool-call')
    throw new Error('缺少用于回放的工具调用')
  expect(events.map(event => event.type)).toEqual(['part-start', 'part-delta', 'part-end', 'usage'])
  expect(events[0]).toMatchObject({ part: { id: call.id, name: call.name, args: {} } })
  const delta = events[1]
  if (delta?.type !== 'part-delta' || delta.delta.type !== 'tool-args')
    throw new Error('工具参数未通过公共增量事件投影')
  expect(JSON.parse(delta.delta.text)).toEqual(call.args)
  expect(events[2]).toMatchObject({ type: 'part-end', part: call })
  expect(events[3]).toEqual({ type: 'usage', usage: first.usage })

  const replay: Request = {
    ...request,
    messages: [
      ...request.messages,
      first.message,
      { role: 'tool', parts: [{ type: 'tool-result', callId: call.id, name: call.name, result: 'written', error }] },
    ],
  }
  const completionEvents: Event[] = []
  const completed = await adapter.stream(replay, (event) => {
    completionEvents.push(event)
  })

  expect(completed.message.finishReason).toBe('completed')
  expect(completed.message.parts.every(part => part.type === 'text')).toBe(true)
  expect(extractText(completed.message)).toBe(error
    ? 'write_note 执行失败，请检查工具结果'
    : '已调用 write_note，写入 Hello from elmino')
  expect(completionEvents.map(event => event.type)).toEqual(['part-start', 'part-delta', 'part-end', 'usage'])
  expect(completionEvents[1]).toMatchObject({ delta: { type: 'text', text: extractText(completed.message) } })
  expect(completionEvents.at(-1)).toEqual({ type: 'usage', usage: completed.usage })
  expect(await adapter.generate(replay)).toEqual(completed)
})

test('demo 已取消请求不生成结果或发布事件', async () => {
  const { adapter } = restoreExampleModel({ ...createModelConfig('demo') })
  const reason = new Error('cancelled before sampling')
  const cancelled = { ...request, signal: AbortSignal.abort(reason) }
  const onEvent = vi.fn()

  await expect(adapter.generate(cancelled)).rejects.toBe(reason)
  await expect(adapter.stream(cancelled, onEvent)).rejects.toBe(reason)
  expect(onEvent).not.toHaveBeenCalled()
})

test('demo 观察者取消后停止发布剩余事件', async () => {
  const { adapter } = restoreExampleModel({ ...createModelConfig('demo') })
  const controller = new AbortController()
  const reason = new Error('cancelled while observing')
  const onEvent = vi.fn(() => controller.abort(reason))

  await expect(adapter.stream({ ...request, signal: controller.signal }, onEvent)).rejects.toBe(reason)
  expect(onEvent).toHaveBeenCalledTimes(1)
})

test('demo 观察者失败保留原始错误且不发布终态', async () => {
  const { adapter } = restoreExampleModel({ ...createModelConfig('demo') })
  const reason = new Error('observer failed')
  const onEvent = vi.fn(() => Promise.reject(reason))

  await expect(adapter.stream(request, onEvent)).rejects.toBe(reason)
  expect(onEvent).toHaveBeenCalledTimes(1)
})

test('demo 明确拒绝未声明支持的结构化生成', async () => {
  const { adapter } = restoreExampleModel({ ...createModelConfig('demo') })

  expect(adapter.capabilities.jsonSchema).toBe(false)
  const generating = adapter.generateObject({ ...request, schema: z.object({ text: z.string() }) })
  await expect(generating).rejects.toThrow('不支持结构化对象生成')
})

test('OpenAI 冻结模型名且只在恢复时装配当前凭据', () => {
  vi.stubEnv('ELMINO_EXAMPLE_MODEL', 'frozen-model')
  vi.stubEnv('ELMINO_EXAMPLE_API_KEY', 'fake-key-at-creation')
  const config = createModelConfig('openai')
  const createProvider = vi.spyOn(ResponsesProvider, 'create')

  expect(JSON.stringify(config)).not.toContain('fake-key-at-creation')
  expect(config).not.toHaveProperty('credential')
  vi.stubEnv('ELMINO_EXAMPLE_MODEL', 'different-model')
  vi.stubEnv('ELMINO_EXAMPLE_API_KEY', undefined)
  expect(() => restoreExampleModel({ ...config })).toThrow('ELMINO_EXAMPLE_API_KEY')
  expect(createProvider).not.toHaveBeenCalled()
  vi.stubEnv('ELMINO_EXAMPLE_API_KEY', 'fake-key-at-restoration')
  const restored = restoreExampleModel({ ...config })

  expect(restored.config).toEqual(config)
  expect(restored.adapter).toBeInstanceOf(ResponsesProvider)
  expect(restored.adapter.model).toBe('frozen-model')
  expect(createProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    model: 'frozen-model',
    credential: 'fake-key-at-restoration',
  }))
  expect(JSON.stringify(restored.config)).not.toContain('fake-key-at-restoration')
})

test('OpenAI 创建配置时需要显式模型名', () => {
  expect(() => createModelConfig('openai')).toThrow('ELMINO_EXAMPLE_MODEL')
})

test.each([
  { providerName: 'unsupported-provider' },
  { credential: 'fake-persisted-secret' },
  { providerName: 'openai' },
])('恢复拒绝不支持或改变 demo 服务归属的配置 %j', (patch) => {
  const config = createModelConfig('demo')
  const createProvider = vi.spyOn(ResponsesProvider, 'create')

  expect(() => restoreExampleModel({ ...config, ...patch })).toThrow(z.ZodError)
  expect(createProvider).not.toHaveBeenCalled()
})

test.each([
  'https://user:fake-password@example.invalid/v1',
  'https://example.invalid/v1?api_key=fake-query-key',
  'https://example.invalid/v1#fake-fragment',
])('接口配置和恢复拒绝包含认证、查询或片段的 URL %s', (baseURL) => {
  vi.stubEnv('ELMINO_EXAMPLE_MODEL', 'test-model')
  const config = createModelConfig('openai')

  vi.stubEnv('ELMINO_EXAMPLE_BASE_URL', baseURL)
  expect(() => createModelConfig('openai')).toThrow(z.ZodError)
  expect(() => restoreExampleModel({ ...config, baseURL })).toThrow(z.ZodError)
})
