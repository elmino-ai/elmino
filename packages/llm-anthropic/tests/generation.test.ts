import type { CapturedRequest } from './support/provider'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { describe, expect, test } from 'vitest'
import { automaticCache, captureCreate, explicitCache, injectClient, request } from './support/provider'

describe('anthropic generation', () => {
  test('Anthropic 映射显式断点、Reasoning、工具调用和缓存用量', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      messages: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          return Promise.resolve({
            id: 'msg_anthropic',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'tool_use',
            stop_sequence: null,
            content: [
              { type: 'thinking', thinking: '先查天气', signature: 'thinking-signature' },
              { type: 'text', text: '我来查询。', citations: [] },
              { type: 'tool_use', id: 'call_anthropic', name: 'weather', input: { city: '杭州' } },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 40,
            },
          })
        },
      },
    })

    const result = await provider.generate({
      ...request,
      cache: { mode: 'explicit' },
    })
    const body = captured.body as {
      system: Array<{ cache_control?: unknown }>
      tools: Array<{ cache_control?: unknown }>
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>
    }

    expect(body.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(result.message.parts).toEqual([
      { type: 'reasoning', text: '先查天气', signature: 'thinking-signature' },
      { type: 'text', text: '我来查询。' },
      {
        type: 'tool-call',
        id: 'call_anthropic',
        name: 'weather',
        args: { city: '杭州' },
        argsText: '{"city":"杭州"}',
      },
    ])
    expect(result.message.finishReason).toBe('tool-calls')
    expect(result.usage).toMatchObject({
      input: 170,
      output: 20,
      reasoning: 0,
      cacheRead: 40,
      cacheWrite: 30,
    })
  })

  test('Anthropic 在调用方不配置时使用适配器内部缓存策略', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      messages: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          return Promise.resolve({
            id: 'msg_anthropic_automatic',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: [{ type: 'text', text: '完成', citations: [] }],
            usage: { input_tokens: 10, output_tokens: 2 },
          })
        },
      },
    })

    await provider.generate(request)
    const body = captured.body as {
      system: Array<{ cache_control?: unknown }>
      tools: Array<{ cache_control?: unknown }>
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>
    }

    expect(body.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('DeepSeek 视觉模型通过 Anthropic 接口接收图片', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: automaticCache,
      credential: 'deepseek-key',
      model: 'deepseek-v4-flash-vision-exp',
      providerName: 'deepseek',
    })
    const captured: CapturedRequest = {}

    injectClient(provider, {
      messages: {
        create: captureCreate(captured, {
          id: 'msg_deepseek_vision',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash-vision-exp',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: '图片中有一张架构图', citations: [] }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      },
    })

    await provider.generate({
      ...request,
      messages: [{
        role: 'user',
        parts: [
          { type: 'text', text: '分析这张图片' },
          { type: 'image', mime: 'image/png', data: 'aGVsbG8=' },
        ],
      }],
    })
    const body = captured.body as {
      messages: Array<{ content: unknown[] }>
    }

    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '分析这张图片' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
    ])
  })

  test('Anthropic 将兼容服务序列化的 thinking 限定在 Provider 上下文', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const captured: CapturedRequest = {}
    let requestCount = 0

    injectClient(provider, {
      messages: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          requestCount++

          return Promise.resolve({
            id: `msg_anthropic_serialized_thinking_${requestCount}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: [{
              type: 'text',
              text: '{"type":"thinking","signature":"","thinking":"内部推理"}\n可见正文',
              citations: [],
            }],
            usage: { input_tokens: 10, output_tokens: 2 },
          })
        },
      },
    })

    const result = await provider.generate(request)
    await provider.generate({
      ...request,
      messages: [...request.messages, result.message],
    })

    expect(result.message.parts).toEqual([
      {
        type: 'reasoning',
        text: '内部推理',
        signature: '',
        metadata: { serialized: true },
        visibility: 'context-only',
      },
      { type: 'text', text: '可见正文' },
    ])
    expect(captured.body?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([expect.objectContaining({
          type: 'text',
          text: '{"type":"thinking","signature":"","thinking":"内部推理"}',
        })]),
      }),
    ]))
  })

  test('Anthropic 将 redacted thinking 作为仅上下文 Part 原样重放', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const captured: CapturedRequest = {}
    let requestCount = 0

    injectClient(provider, {
      messages: {
        create: (body: Record<string, unknown>) => {
          captured.body = body
          requestCount++

          return Promise.resolve({
            id: `msg_anthropic_redacted_${requestCount}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: requestCount === 1
              ? [{ type: 'redacted_thinking', data: 'opaque-reasoning' }]
              : [{ type: 'text', text: '完成', citations: [] }],
            usage: { input_tokens: 10, output_tokens: 2 },
          })
        },
      },
    })

    const first = await provider.generate(request)

    await provider.generate({
      ...request,
      messages: [...request.messages, first.message],
    })

    expect(first.message.parts).toEqual([{
      type: 'reasoning',
      text: '',
      signature: 'opaque-reasoning',
      metadata: { redacted: true },
      visibility: 'context-only',
    }])
    expect(JSON.stringify(captured.body)).toContain('opaque-reasoning')
  })
})
