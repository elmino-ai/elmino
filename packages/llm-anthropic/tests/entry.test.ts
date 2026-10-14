import type { Provider } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { asyncIterable, captureCreate, injectClient, request } from './support/provider'

/** SDK 替身完整响应 */
const response = {
  id: 'msg-test',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  stop_reason: 'end_turn',
  stop_sequence: null,
  content: [{ type: 'text', text: '{"city":"杭州"}', citations: [] }],
  usage: { input_tokens: 8, output_tokens: 2 },
}

describe('Anthropic 独立包公共入口', () => {
  test.each([
    { providerName: 'anthropic', header: 'x-api-key', value: 'test-key' },
    { providerName: 'mimo', header: 'authorization', value: 'Bearer test-key' },
    { providerName: 'local', header: 'authorization', value: null },
  ])('$providerName 的认证类型由适配器装配，通过真实 SDK 请求验证', async (input) => {
    const { providerName, header, value } = input
    const provider = AnthropicMessagesProvider.create({
      model: 'test-model',
      providerName,
      credential: 'test-key',
      apiKeyRequired: providerName !== 'local',
      baseURL: 'http://localhost:11434',
    })
    const client = Reflect.get(provider, '_client') as { fetch: typeof fetch }
    let headers: Headers | undefined

    client.fetch = (_url, init) => {
      headers = new Headers(init?.headers)
      return Promise.resolve(new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }))
    }
    await provider.generate(request)

    expect(headers?.get(header)).toBe(value)
    if (providerName === 'local')
      expect(headers?.get('x-api-key')).toBeNull()
  })

  test('结构化输出关闭 thinking，保留统一结果和用量', async () => {
    const provider = AnthropicMessagesProvider.create({ model: 'test-model', credential: 'test-key' })
    const captured: { body?: Record<string, unknown> } = {}

    injectClient(provider, { messages: { create: captureCreate(captured, response) } })
    const result = await provider.generateObject({
      ...request,
      schema: z.object({ city: z.string() }),
      reasoning: { thinking: { type: 'enabled' } },
    })

    expect(result.object.city).toBe('杭州')
    expect(result.usage.input).toBe(8)
    expect(captured.body?.thinking).toEqual({ type: 'disabled' })
  })

  test('兼容服务不支持原生 token 计数时返回 undefined，实例内不重复尝试', async () => {
    const provider: Provider = AnthropicMessagesProvider.create({ model: 'test-model', credential: 'test-key' })
    const countTokens = vi.fn().mockRejectedValue(new Error('not supported'))

    injectClient(provider, { messages: { countTokens } })
    await expect(provider.countTokens?.(request)).resolves.toBeUndefined()
    await expect(provider.countTokens?.(request)).resolves.toBeUndefined()
    expect(countTokens).toHaveBeenCalledTimes(1)
  })

  test('流事件处理失败直接中断，不伪造最终结果', async () => {
    const provider = AnthropicMessagesProvider.create({ model: 'test-model', credential: 'test-key' })
    const finalMessage = vi.fn().mockResolvedValue(response)
    const stream = Object.assign(asyncIterable([{
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }]), { finalMessage })
    const error = new Error('consumer failed')

    injectClient(provider, { messages: { stream: () => stream } })
    await expect(provider.stream(request, () => {
      throw error
    })).rejects.toBe(error)
    expect(finalMessage).not.toHaveBeenCalled()
  })
})
