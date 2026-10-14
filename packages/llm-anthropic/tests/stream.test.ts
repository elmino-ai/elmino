import type { Event } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { describe, expect, test } from 'vitest'
import { asyncIterable, explicitCache, injectClient, request } from './support/provider.js'

describe('anthropic stream', () => {
  test('Anthropic 流式工具参数从空 input 开始按多个 delta 合成完整 Part', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const tool = {
      type: 'tool_use',
      id: 'call_anthropic_delta',
      name: 'weather',
      input: { city: '杭州' },
    }
    const response = {
      id: 'msg_anthropic_tool_delta',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      content: [tool],
      usage: { input_tokens: 8, output_tokens: 4 },
    }
    const stream = asyncIterable([
      { type: 'message_start', message: { id: response.id, usage: { input_tokens: 8, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { ...tool, input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city"' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ':"杭州"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    ]) as ReturnType<typeof asyncIterable> & {
      /** 流式累积的原生最终消息 */
      currentMessage?: typeof response
      /** 读取原生最终消息 */
      finalMessage?: () => Promise<typeof response>
    }
    const events: Event[] = []

    stream.currentMessage = response
    stream.finalMessage = () => Promise.resolve(response)
    injectClient(provider, { messages: { stream: () => stream } })
    const result = await provider.stream(request, (event) => {
      events.push(event)
    })
    const started = events.find(event => event.type === 'part-start')
    const ended = events.find(event => event.type === 'part-end')
    const deltas = events.flatMap(event => (
      event.type === 'part-delta' && event.delta.type === 'tool-args'
        ? [event.delta.text]
        : []
    ))

    expect(started).toMatchObject({
      type: 'part-start',
      part: { type: 'tool-call', args: {}, argsText: '' },
    })
    expect(started).not.toHaveProperty('part.invalidArgs')
    expect(deltas).toEqual(['{"city"', ':"杭州"}'])
    expect(ended).toMatchObject({
      type: 'part-end',
      part: {
        type: 'tool-call',
        args: { city: '杭州' },
        argsText: '{"city":"杭州"}',
      },
    })
    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      args: { city: '杭州' },
      argsText: '{"city":"杭州"}',
    }))
    expect(JSON.stringify(result.message.parts)).not.toContain('invalidArgs')
  })

  test('Anthropic 将 start 的非空工具参数转为首个 delta', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const tool = {
      type: 'tool_use',
      id: 'call_anthropic_initial',
      name: 'weather',
      input: { city: '杭州' },
    }
    const response = {
      id: 'msg_anthropic_tool_initial',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      content: [tool],
      usage: { input_tokens: 8, output_tokens: 4 },
    }
    const stream = asyncIterable([
      { type: 'content_block_start', index: 0, content_block: tool },
      { type: 'content_block_stop', index: 0 },
    ]) as ReturnType<typeof asyncIterable> & {
      currentMessage?: typeof response
      finalMessage?: () => Promise<typeof response>
    }
    const events: Event[] = []

    stream.currentMessage = response
    stream.finalMessage = () => Promise.resolve(response)
    injectClient(provider, { messages: { stream: () => stream } })
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

  test('Anthropic 流式序列化 thinking 即使跨增量也不会泄漏为正文', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const text = '{"type":"thinking","signature":"","thinking":"内部推理"}\n可见正文'
    const finalMessage = {
      id: 'msg_anthropic_serialized_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text, citations: [] }],
      usage: { input_tokens: 8, output_tokens: 2 },
    }
    const stream = asyncIterable([
      {
        type: 'message_start',
        message: { id: finalMessage.id, usage: { input_tokens: 8, output_tokens: 0 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 28) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(28, 55) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(55) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]) as ReturnType<typeof asyncIterable> & {
      /** 流式累积的原生最终消息 */
      currentMessage?: typeof finalMessage
      /** 读取原生最终消息 */
      finalMessage?: () => Promise<typeof finalMessage>
    }
    const events: Event[] = []

    stream.currentMessage = finalMessage
    stream.finalMessage = () => Promise.resolve(finalMessage)
    injectClient(provider, { messages: { stream: () => stream } })
    const result = await provider.stream(request, (event) => {
      events.push(event)
    })
    const visibleText = events
      .filter(event => event.type === 'part-delta' && event.delta.type === 'text')
      .map(event => event.type === 'part-delta' ? event.delta.text : '')
      .join('')

    expect(visibleText).toBe('可见正文')
    expect(visibleText).not.toContain('内部推理')
    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'reasoning',
      text: '内部推理',
      visibility: 'context-only',
    }))
  })

  test('Anthropic 流式 redacted thinking 只进入最终 Message', async () => {
    const provider = AnthropicMessagesProvider.create({
      cache: explicitCache,
      credential: 'test-key',
      model: 'claude-sonnet-5',
    })
    const response = {
      id: 'msg_anthropic_redacted_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'redacted_thinking', data: 'opaque-stream' }],
      usage: { input_tokens: 8, output_tokens: 2 },
    }
    const stream = asyncIterable([
      { type: 'message_start', message: { id: response.id, usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: response.content[0] },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]) as ReturnType<typeof asyncIterable> & {
      /** 流式累积的原生最终消息 */
      currentMessage?: typeof response
      /** 读取原生最终消息 */
      finalMessage?: () => Promise<typeof response>
    }
    const events: Event[] = []

    stream.currentMessage = response
    stream.finalMessage = () => Promise.resolve(response)
    injectClient(provider, { messages: { stream: () => stream } })
    const result = await provider.stream(request, (event) => {
      events.push(event)
    })

    expect(events.every(event => event.type === 'usage')).toBe(true)
    expect(result.message.parts).toContainEqual(expect.objectContaining({
      type: 'reasoning',
      signature: 'opaque-stream',
      visibility: 'context-only',
    }))
  })
})
