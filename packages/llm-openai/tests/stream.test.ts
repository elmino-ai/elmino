import type { Event } from '@elmino/llm'
import type { CapturedRequest } from './support/provider'
import { ChatCompletionsProvider, ResponsesProvider } from '@elmino/llm-openai'
import { describe, expect, test } from 'vitest'
import {
  asyncIterable,
  automaticCache,
  createBailianChat,
  createBigModelProvider,
  explicitCache,
  injectClient,
  openAIResponse,
  request,
} from './support/provider'

describe('openai stream', () => {
  test('Chat Completions 等待稳定工具身份后完整转发参数增量', async () => {
    const provider = ChatCompletionsProvider.create({
      cache: automaticCache,
      credential: 'test-key',
      model: 'gpt-test',
      providerName: 'openai',
    })
    const events: Event[] = []

    injectClient(provider, {
      chat: {
        completions: {
          create: () => Promise.resolve(asyncIterable([
            {
              id: 'chatcmpl_tool_delta',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_chat_delta',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"杭' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl_tool_delta',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { name: 'Lookup', arguments: '州"' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl_tool_delta',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { arguments: '}' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl_tool_delta',
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            },
          ])),
        },
      },
    })

    const result = await provider.stream({
      ...request,
      tools: [{
        name: 'weatherLookup',
        description: '读取天气',
        schema: request.tools?.[0]?.schema ?? {},
      }],
    }, (event) => {
      events.push(event)
    })
    const toolEvents = events.filter(event => (
      event.type === 'part-start'
      || event.type === 'part-end'
      || (event.type === 'part-delta' && event.delta.type === 'tool-args')
    ))

    expect(toolEvents).toMatchObject([
      {
        type: 'part-start',
        part: {
          type: 'tool-call',
          id: 'call_chat_delta',
          name: 'weatherLookup',
          args: {},
          argsText: '',
        },
      },
      { type: 'part-delta', delta: { type: 'tool-args', text: '{"city":"杭州"' } },
      { type: 'part-delta', delta: { type: 'tool-args', text: '}' } },
      {
        type: 'part-end',
        part: { type: 'tool-call', args: { city: '杭州' }, argsText: '{"city":"杭州"}' },
      },
    ])
    expect(toolEvents[0]).not.toHaveProperty('part.invalidArgs')
    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      id: 'call_chat_delta',
      name: 'weatherLookup',
      args: { city: '杭州' },
    }))
  })

  test('Chat Completions 不会把 stop 结束的工具片段提升为可执行工具响应', async () => {
    const provider = ChatCompletionsProvider.create({
      cache: automaticCache,
      credential: 'test-key',
      model: 'gpt-test',
      providerName: 'openai',
    })

    injectClient(provider, {
      chat: {
        completions: {
          create: () => Promise.resolve(asyncIterable([
            {
              id: 'chatcmpl_tool_with_stop',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_stop_tool',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"杭州"}' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl_tool_with_stop',
              choices: [{ delta: {}, finish_reason: 'stop' }],
            },
          ])),
        },
      },
    })

    const result = await provider.stream(request)

    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      id: 'call_stop_tool',
    }))
    expect(result.message.finishReason).toBe('completed')
  })

  test('Chat Completions 不会把残缺工具参数伪装成完整参数', async () => {
    const provider = ChatCompletionsProvider.create({
      cache: automaticCache,
      credential: 'test-key',
      model: 'gpt-test',
      providerName: 'openai',
    })

    injectClient(provider, {
      chat: {
        completions: {
          create: () => Promise.resolve(asyncIterable([
            {
              id: 'chatcmpl_invalid_tool_args',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_invalid_args',
                    type: 'function',
                    function: { name: 'writeFile', arguments: '{' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl_invalid_tool_args',
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            },
          ])),
        },
      },
    })

    const result = await provider.stream(request)

    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      id: 'call_invalid_args',
      invalidArgs: true,
    }))
  })

  test('流错误直接保留 Provider 原始错误', async () => {
    const provider = createBailianChat({
      cache: explicitCache,
      credential: 'test-key',
      model: 'qwen3.7-plus',
    })
    const events: Event[] = []

    injectClient(provider, {
      chat: {
        completions: {
          create: () => Promise.resolve(asyncIterable([
            { id: 'qwen_failed', choices: [{ delta: { content: '开始' }, finish_reason: null }] },
          ], new Error('连接中断'))),
        },
      },
    })

    await expect(provider.stream(request, (event) => {
      events.push(event)
    })).rejects.toThrow('连接中断')
    expect(events.at(-1)).toMatchObject({
      type: 'part-delta',
      delta: { type: 'text', text: '开始' },
    })
  })

  test('OpenAI incomplete 流按截断终态返回完整 Message', async () => {
    const provider = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const messageItem = {
      type: 'message',
      id: 'message_incomplete',
      role: 'assistant',
      status: 'incomplete',
      content: [{ type: 'output_text', text: '未完内容', annotations: [], logprobs: [] }],
    }
    const response = {
      ...openAIResponse(),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '未完内容',
      output: [messageItem],
    }

    injectClient(provider, {
      responses: {
        create: () => Promise.resolve(asyncIterable([
          { type: 'response.created', response },
          { type: 'response.output_item.added', output_index: 0, item: messageItem },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '未完内容' },
          { type: 'response.output_item.done', output_index: 0, item: messageItem },
          { type: 'response.incomplete', response },
        ])),
      },
    })

    const result = await provider.stream(request)

    expect(result.message.finishReason).toBe('truncated')
    expect(result.message.parts).toContainEqual({ type: 'text', text: '未完内容' })
  })

  test('OpenAI Responses 将 function call 初始参数投影为 delta', async () => {
    const provider = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const response = openAIResponse()
    const item = response.output[2]
    const events: Event[] = []

    injectClient(provider, {
      responses: {
        create: () => Promise.resolve(asyncIterable([
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ])),
      },
    })
    await provider.stream(request, (event) => {
      events.push(event)
    })

    expect(events.slice(0, 3)).toEqual([
      expect.objectContaining({
        type: 'part-start',
        part: expect.objectContaining({ args: {}, argsText: '' }),
      }),
      { type: 'part-delta', index: 0, delta: { type: 'tool-args', text: '{"city":"杭州"}' } },
      expect.objectContaining({
        type: 'part-end',
        part: expect.objectContaining({ args: { city: '杭州' } }),
      }),
    ])
    expect(events[0]).not.toHaveProperty('part.invalidArgs')
  })

  test('OpenAI reasoning summary 完成事件结束统一 Reasoning Part', async () => {
    const provider = ResponsesProvider.create({ cache: explicitCache, credential: 'test-key', model: 'gpt-5.6' })
    const response = openAIResponse()
    const item = {
      type: 'reasoning',
      id: 'reasoning_stream',
      encrypted_content: 'encrypted-stream',
      summary: [{ type: 'summary_text', text: '先分析' }],
      content: [{ type: 'reasoning_text', text: '再验证' }],
      status: 'completed',
    }
    const events: Event[] = []

    injectClient(provider, {
      responses: {
        create: () => Promise.resolve(asyncIterable([
          { type: 'response.created', response },
          { type: 'response.output_item.added', output_index: 0, item },
          {
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            summary_index: 0,
            delta: '先分析',
          },
          {
            type: 'response.reasoning_summary_text.done',
            output_index: 0,
            summary_index: 0,
            text: '先分析',
          },
          {
            type: 'response.reasoning_text.delta',
            output_index: 0,
            content_index: 0,
            delta: '再验证',
          },
          {
            type: 'response.reasoning_text.done',
            output_index: 0,
            content_index: 0,
            text: '再验证',
          },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ])),
      },
    })

    await provider.stream(request, (event) => {
      events.push(event)
    })

    expect(events.filter(event => event.type === 'part-start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'part-end')).toEqual([expect.objectContaining({
      type: 'part-end',
      index: 0,
      part: expect.objectContaining({ type: 'reasoning', text: '先分析\n再验证' }),
    })])
  })

  test('BigModel Coding Plan 仅在流式请求开启工具流并合并参数与缓存用量', async () => {
    const provider = createBigModelProvider('glm-5.3')
    const captured: CapturedRequest = {}

    injectClient(provider, {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            captured.body = body
            return Promise.resolve(asyncIterable([
              {
                id: 'chatcmpl_bigmodel_stream',
                choices: [{ delta: { reasoning_content: '先查天气' }, finish_reason: null }],
              },
              {
                id: 'chatcmpl_bigmodel_stream',
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: 'call_bigmodel',
                      type: 'function',
                      function: { name: 'weather', arguments: '{"city":"杭' },
                    }],
                  },
                  finish_reason: null,
                }],
              },
              {
                id: 'chatcmpl_bigmodel_stream',
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: { arguments: '州"}' },
                    }],
                  },
                  finish_reason: null,
                }],
              },
              {
                id: 'chatcmpl_bigmodel_stream',
                choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                  total_tokens: 120,
                  prompt_tokens_details: { cached_tokens: 40 },
                  completion_tokens_details: { reasoning_tokens: 5 },
                },
              },
            ]))
          },
        },
      },
    })

    const result = await provider.stream(request)

    expect(captured.body?.stream).toBe(true)
    expect(captured.body?.tool_stream).toBe(true)
    expect(captured.body?.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      id: 'call_bigmodel',
      name: 'weather',
      args: { city: '杭州' },
    }))
    expect(result.usage).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 40,
    })
  })
})
