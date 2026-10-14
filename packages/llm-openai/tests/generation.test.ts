import type { Request } from '@elmino/llm'
import type { CapturedRequest } from './support/provider.js'
import { ChatCompletionsProvider, ResponsesProvider } from '@elmino/llm-openai'
import { validateCache } from '@elmino/llm/cache'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  asyncIterable,
  automaticCache,
  captureCreate,
  captureRequestHeaders,
  createBailianChat,
  createBigModelProvider,
  createBigModelResponse,
  explicitCache,
  injectClient,
  openAIResponse,
  qwenResponse,
  request,
} from './support/provider.js'

describe('openai generation', () => {
  test('需要认证的供应商缺少 API Key 时在工厂边界失败', () => {
    expect(() => ChatCompletionsProvider.create({
      providerName: 'custom',
      baseURL: 'https://example.com/v1',
      cache: automaticCache,
      jsonSchema: true,
      model: 'remote-model',
    })).toThrow('请先为 custom 配置 API Key')
  })

  test.each([
    'k3',
    'k3-256k',
  ])('Kimi K3 系列在 Chat Profile 内固定原生思考、缓存和工具 Schema 策略：%s', async (model) => {
    const provider = ChatCompletionsProvider.create({
      credential: 'kimi-key',
      providerName: 'kimi',
      baseURL: 'https://api.kimi.com/coding/v1',
      cache: automaticCache,
      jsonSchema: true,
      model,
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            captured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    await provider.generate({
      ...request,
      messages: [
        { role: 'assistant', parts: [{ type: 'text', text: '上一轮' }] },
        { role: 'user', parts: [{ type: 'text', text: '继续' }] },
      ],
      tools: [{
        name: 'weather',
        schema: {
          type: 'object',
          properties: {
            filters: {
              items: {
                properties: { level: { enum: ['warning'] } },
              },
            },
            mode: { enum: ['fast'] },
            route: {
              oneOf: [{ properties: { kind: { const: 'direct' } } }],
            },
          },
        },
      }],
      cache: { mode: 'automatic' },
      cacheKey: 'thread_test',
    })

    const body = captured.body as {
      max_completion_tokens: number
      max_tokens?: number
      messages: Array<{ reasoning_content?: string, role: string }>
      prompt_cache_key: string
      thinking: Record<string, unknown>
      tools: Array<{ function: { parameters: Record<string, unknown> } }>
    }
    const assistant = body.messages.find(message => message.role === 'assistant')
    const parameters = body.tools[0]?.function.parameters as {
      properties: {
        filters: { items: { properties: { level: Record<string, unknown> } } }
        mode: Record<string, unknown>
        route: { oneOf: Array<{ properties: { kind: Record<string, unknown> } }> }
      }
    }

    expect(provider.name).toBe('kimi')
    expect(provider).toBeInstanceOf(ChatCompletionsProvider)
    expect(provider.capabilities.cache.modes).toEqual(['automatic', 'disabled'])
    expect(body.max_completion_tokens).toBe(1024)
    expect(body.max_tokens).toBeUndefined()
    expect(body.prompt_cache_key).toBe('thread_test')
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'max', keep: 'all' })
    expect(assistant?.reasoning_content).toBe('')
    expect(parameters.properties.mode).toEqual({ enum: ['fast'], type: 'string' })
    expect(parameters.properties.filters.items.properties.level)
      .toEqual({ enum: ['warning'], type: 'string' })
    expect(parameters.properties.route.oneOf[0]?.properties.kind)
      .toEqual({ const: 'direct', type: 'string' })
  })

  test.each([
    'kimi-for-coding',
    'kimi-for-coding-highspeed',
  ])('Kimi K2.7 Code 模型固定开启无 effort 的原生思考：%s', async (model) => {
    const provider = ChatCompletionsProvider.create({
      credential: 'kimi-key',
      providerName: 'kimi',
      baseURL: 'https://api.kimi.com/coding/v1',
      cache: automaticCache,
      jsonSchema: true,
      model,
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            captured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    await provider.generate(request)

    expect(captured.body?.thinking).toEqual({ type: 'enabled', keep: 'all' })
  })

  test('OpenAI Responses 映射稳定缓存键、断点、Reasoning 和细分用量', async () => {
    const provider = ResponsesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'gpt-5.6',
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      responses: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          return Promise.resolve(openAIResponse())
        },
      },
    })

    const result = await provider.generate({
      ...request,
      cache: { mode: 'explicit' },
      cacheKey: 'agent-main:v1',
    })
    const body = captured.body as {
      input: Array<{ content?: Array<{ prompt_cache_breakpoint?: unknown }> }>
      prompt_cache_key: string
      prompt_cache_options: unknown
    }

    expect(body.prompt_cache_key).toBe('agent-main:v1')
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
    expect(body.input[0]?.content?.at(-1)?.prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
    expect(body.input[1]?.content?.at(-1)?.prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
    expect(result.message.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(result.message.finishReason).toBe('tool-calls')
    expect(result.usage).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 40,
      cacheWrite: 10,
    })
  })

  test('OpenAI Responses 按统一 Message Part 顺序重放原生历史项', async () => {
    const provider = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      responses: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          return Promise.resolve(openAIResponse())
        },
      },
    })

    await provider.generate({
      ...request,
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: '先分析',
              signature: 'encrypted-reasoning',
              metadata: { id: 'reasoning_native' },
            },
            { type: 'text', text: '准备调用工具' },
            { type: 'tool-call', id: 'call_native', name: 'weather', args: { city: '杭州' } },
          ],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool-result', callId: 'call_native', result: '晴天' }],
        },
      ],
    })

    const input = captured.body?.input as Array<{
      id?: string
      role?: string
      type?: string
    }>

    expect(input.map(item => item.type ?? item.role)).toEqual([
      'system',
      'reasoning',
      'assistant',
      'function_call',
      'function_call_output',
    ])
    expect(input[1]?.id).toBe('reasoning_native')
  })

  test('Responses 只在公共历史严格追加时续接服务端会话', async () => {
    const provider = ResponsesProvider.create({
      cache: automaticCache,
      credential: 'test-key',
      model: 'qwen3.7-flash',
      providerName: 'aliyun-bailian',
    })
    const calls: Array<{
      body: Record<string, unknown>
      options?: { headers?: Record<string, string> }
    }> = []
    let responseIndex = 0

    injectClient(provider, {
      responses: {
        create: (body: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
          responseIndex += 1
          calls.push({ body, options })
          return Promise.resolve({
            ...openAIResponse(),
            id: `resp_session_${responseIndex}`,
          })
        },
      },
    })

    const first = await provider.generate({
      ...request,
      cache: automaticCache,
      cacheKey: 'thread_session',
    })
    const secondUser = { role: 'user' as const, parts: [{ type: 'text' as const, text: '继续' }] }
    const second = await provider.generate({
      ...request,
      cache: automaticCache,
      cacheKey: 'thread_session',
      messages: [...request.messages, first.message, secondUser],
    })

    await provider.generate({
      ...request,
      cache: automaticCache,
      cacheKey: 'thread_session',
      system: [{ type: 'text', text: '系统提示已经变化' }],
      messages: [...request.messages, first.message, secondUser, second.message],
    })

    expect(calls[0]?.body).not.toHaveProperty('previous_response_id')
    expect(calls[1]?.body).toMatchObject({ previous_response_id: 'resp_session_1' })
    expect(calls[1]?.body.input).toEqual([{
      role: 'user',
      content: [{ type: 'input_text', text: '继续' }],
    }])
    expect(calls[2]?.body).not.toHaveProperty('previous_response_id')
    expect(calls[2]?.body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system' }),
    ]))
    expect(calls.every(call => call.options?.headers?.['x-dashscope-session-cache'] === 'enable'))
      .toBe(true)
  })

  test('Responses 失败响应不会推进服务端会话', async () => {
    const provider = ResponsesProvider.create({
      cache: automaticCache,
      credential: 'test-key',
      model: 'qwen3.7-flash',
      providerName: 'aliyun-bailian',
    })
    const calls: Array<Record<string, unknown>> = []
    let failed = true

    injectClient(provider, {
      responses: {
        create: (body: Record<string, unknown>) => {
          calls.push(body)
          if (!failed)
            return Promise.resolve(openAIResponse())

          failed = false
          return Promise.resolve({
            ...openAIResponse(),
            error: { code: 'upstream_error', message: '上游失败' },
            id: 'resp_failed',
            output: [],
            status: 'failed',
          })
        },
      },
    })

    const result = await provider.generate({
      ...request,
      cache: automaticCache,
      cacheKey: 'thread_failed_session',
    })

    await provider.generate({
      ...request,
      cache: automaticCache,
      cacheKey: 'thread_failed_session',
      messages: [...request.messages, result.message],
    })

    expect(result.message.finishReason).toBe('error')
    expect(calls[1]).not.toHaveProperty('previous_response_id')
  })

  test('阿里云百炼默认映射显式缓存扩展、Reasoning、工具调用和细分用量', async () => {
    const provider = createBailianChat({
      cache: explicitCache,
      credential: 'test-key',
      model: 'qwen3.7-plus',
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            captured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    const result = await provider.generate(request)
    const body = captured.body as {
      messages: Array<{ content: string | Array<{ cache_control?: unknown }> }>
    }

    expect(Array.isArray(body.messages[0]?.content)).toBe(true)
    expect((body.messages[0]?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control)
      .toEqual({ type: 'ephemeral' })
    expect((body.messages[1]?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control)
      .toEqual({ type: 'ephemeral' })
    expect(result.message.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(result.message.finishReason).toBe('tool-calls')
    expect(result.usage).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 40,
      cacheWrite: 10,
    })
  })

  test('阿里云百炼只在流式 GLM 请求补充工具流并保留 Kimi 历史思考', async () => {
    const glm = createBailianChat({ cache: explicitCache, credential: 'test-key', model: 'glm-5.2' })
    const kimi = createBailianChat({ cache: explicitCache, credential: 'test-key', model: 'kimi/kimi-k3' })
    const glmCaptured: CapturedRequest = {}
    const kimiCaptured: CapturedRequest = {}

    injectClient(glm, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            glmCaptured.body = body
            return body.stream
              ? Promise.resolve(asyncIterable([{
                  id: 'chatcmpl_glm_stream',
                  choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
                }]))
              : Promise.resolve(qwenResponse())
          },
        },
      },
    })
    injectClient(kimi, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            kimiCaptured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    await glm.stream(request)
    await kimi.generate({
      ...request,
      messages: [{
        role: 'assistant',
        parts: [{ type: 'text', text: '继续调用工具' }],
      }],
    })

    expect(glmCaptured.body?.tool_stream).toBe(true)
    expect((kimiCaptured.body?.messages as Array<{
      reasoning_content?: string
      role: string
    }>).find(message => message.role === 'assistant'))
      .toHaveProperty('reasoning_content', '')
  })

  test('OpenAI 与阿里云百炼只在最新工具结果末尾放置显式断点', async () => {
    const messages: Request['messages'] = [{
      role: 'tool',
      parts: [
        { type: 'tool-result', callId: 'call_first', result: '第一项' },
        { type: 'tool-result', callId: 'call_last', result: '最后一项' },
      ],
    }]
    const openai = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const qwen = createBailianChat({ cache: explicitCache, credential: 'test-key', model: 'qwen3.7-plus' })
    const openAICaptured: CapturedRequest = {}
    const qwenCaptured: CapturedRequest = {}

    injectClient(openai, {
      responses: {
        create: (body: Record<string, unknown>) => {
          openAICaptured.body = body
          return Promise.resolve(openAIResponse())
        },
      },
    })
    injectClient(qwen, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            qwenCaptured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    const cache: Request['cache'] = { mode: 'explicit' }

    await openai.generate({ ...request, messages, cache })
    await qwen.generate({
      ...request,
      messages,
      cache: { mode: 'explicit' },
    })

    const openAIOutputs = (openAICaptured.body?.input as Array<{
      output?: string | Array<{ prompt_cache_breakpoint?: unknown }>
      type?: string
    }>).filter(item => item.type === 'function_call_output')
    const qwenTools = (qwenCaptured.body?.messages as Array<{
      content: string | Array<{ cache_control?: unknown }>
      role: string
    }>).filter(message => message.role === 'tool')

    expect(openAIOutputs[0]?.output).toBe('第一项')
    expect((openAIOutputs[1]?.output as Array<{ prompt_cache_breakpoint?: unknown }>).at(-1)?.prompt_cache_breakpoint)
      .toEqual({ mode: 'explicit' })
    expect(qwenTools[0]?.content).toBe('第一项')
    expect((qwenTools[1]?.content as Array<{ cache_control?: unknown }>).at(-1)?.cache_control)
      .toEqual({ type: 'ephemeral' })
  })

  test('阿里云百炼多段用户内容只标记最后一个可缓存文本块', async () => {
    const provider = createBailianChat({ cache: explicitCache, credential: 'test-key', model: 'qwen3.7-plus' })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            captured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    await provider.generate({
      ...request,
      messages: [{
        role: 'user',
        parts: [
          { type: 'text', text: '稳定前缀' },
          { type: 'text', text: '动态问题' },
        ],
      }],
      cache: { mode: 'explicit' },
    })

    const messages = (captured.body?.messages as Array<{
      content: Array<{ cache_control?: unknown }>
      role: string
    }>).filter(message => message.role === 'user')

    expect(messages[0]?.content[0]?.cache_control).toBeUndefined()
    expect(messages[0]?.content[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('连接诊断可统一禁用 OpenAI 与阿里云百炼原生缓存参数', async () => {
    const openai = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const qwen = createBailianChat({ cache: explicitCache, credential: 'test-key', model: 'qwen3.7-plus' })
    const openAICaptured: CapturedRequest = {}
    const qwenCaptured: CapturedRequest = {}

    injectClient(openai, {
      responses: {
        create: (body: Record<string, unknown>) => {
          openAICaptured.body = body
          return Promise.resolve(openAIResponse())
        },
      },
    })
    injectClient(qwen, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            qwenCaptured.body = body
            return Promise.resolve(qwenResponse())
          },
        },
      },
    })

    await openai.generate({ ...request, cache: { mode: 'disabled' } })
    await qwen.generate({ ...request, cache: { mode: 'disabled' } })

    expect(openAICaptured.body).not.toHaveProperty('prompt_cache_options')
    expect(JSON.stringify(openAICaptured.body)).not.toContain('prompt_cache_breakpoint')
    expect(JSON.stringify(qwenCaptured.body)).not.toContain('cache_control')
  })

  test('只校验缓存模式，显式断点由 Provider 策略声明', () => {
    const capabilities = ResponsesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'gpt-5.6',
    }).capabilities

    expect(() => validateCache({ mode: 'explicit' }, capabilities.cache)).not.toThrow()
    expect(capabilities.cache.breakpoints).toEqual(['system', 'latest-user'])
    expect(() => validateCache(
      { mode: 'explicit' },
      { modes: ['automatic', 'disabled'] },
    )).toThrow('Provider explicit 缓存模式不受支持')
  })

  test('BigModel Coding Plan 使用 Bearer 认证并保留历史思考', async () => {
    const provider = createBigModelProvider('glm-5.3', 'bigmodel-key')
    const captured: CapturedRequest = {}
    const response = createBigModelResponse()

    injectClient(provider, {
      chat: {
        completions: {
          create: captureCreate(captured, response),
        },
      },
    })
    await provider.generate({
      ...request,
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '保留的思考' },
            { type: 'text', text: '继续回答' },
          ],
        },
        ...request.messages,
      ],
      reasoning: { reasoning_effort: 'high' },
    })
    const assistant = (captured.body?.messages as Array<Record<string, unknown>>)
      .find(message => message.role === 'assistant')

    expect(captured.body?.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(captured.body?.reasoning_effort).toBe('high')
    expect(captured.body).not.toHaveProperty('tool_stream')
    expect(assistant?.reasoning_content).toBe('保留的思考')

    const headers = await captureRequestHeaders(
      createBigModelProvider('glm-5.3', 'bigmodel-key'),
      response,
    )

    expect(headers.get('authorization')).toBe('Bearer bigmodel-key')
  })

  test('BigModel Coding Plan 结构化输出使用 JSON Object 并按模型收紧思考', async () => {
    const schema = z.object({ title: z.string() })
    const glm53 = createBigModelProvider('glm-5.3')
    const glm52 = createBigModelProvider('glm-5.2')
    const glm53Captured: CapturedRequest = {}
    const glm52Captured: CapturedRequest = {}
    const response = createBigModelResponse('{"title":"完成"}')

    injectClient(glm53, {
      chat: { completions: { create: captureCreate(glm53Captured, response) } },
    })
    injectClient(glm52, {
      chat: { completions: { create: captureCreate(glm52Captured, response) } },
    })

    await expect(glm53.generateObject({ ...request, schema })).resolves.toMatchObject({
      object: { title: '完成' },
    })
    await expect(glm52.generateObject({ ...request, schema })).resolves.toMatchObject({
      object: { title: '完成' },
    })

    expect(glm53Captured.body?.response_format).toEqual({ type: 'json_object' })
    expect(glm53Captured.body?.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(glm53Captured.body?.reasoning_effort).toBe('low')
    expect(JSON.stringify(glm53Captured.body?.messages)).toContain('JSON Schema')
    expect(JSON.stringify(glm53Captured.body)).not.toContain('json_schema')
    expect(glm52Captured.body?.thinking).toEqual({ type: 'disabled', clear_thinking: false })
  })
})
