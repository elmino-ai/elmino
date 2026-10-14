import type { Provider } from '@elmino/llm'
import { ChatCompletionsProvider, ResponsesProvider } from '@elmino/llm-openai'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  captureCreate,
  captureRequestHeaders,
  injectClient,
  openAIResponse,
  qwenResponse,
  request,
} from './support/provider.js'

describe('OpenAI 独立包公共入口', () => {
  test.each([ChatCompletionsProvider, ResponsesProvider])(
    '%s 免认证端点通过真实 SDK 构建请求时不发送认证头',
    async (Adapter) => {
      const provider: Provider = Adapter.create({
        model: 'local',
        providerName: 'local',
        baseURL: 'http://localhost:11434/v1',
        apiKeyRequired: false,
        credential: 'must-not-leak',
      })
      const response = Adapter === ResponsesProvider ? openAIResponse() : qwenResponse()
      const headers = await captureRequestHeaders(provider, response)

      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('x-api-key')).toBeNull()
      expect([...headers.values()].join(' ')).not.toContain('must-not-leak')
      expect([...headers.values()].join(' ')).not.toContain('not-required')
    },
  )

  test.each([ChatCompletionsProvider, ResponsesProvider])(
    '%s 结构化输出显式关闭推理并校验 Schema',
    async (Adapter) => {
      const provider = Adapter.create({ model: 'test-model', credential: 'test-key' })
      const captured: { body?: Record<string, unknown> } = {}
      const response = Adapter === ResponsesProvider ? openAIResponse() : qwenResponse()

      if ('output' in response) {
        response.output = [{
          type: 'message',
          id: 'message-json',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"city":"杭州"}', annotations: [], logprobs: [] }],
        }]
        injectClient(provider, { responses: { create: captureCreate(captured, response) } })
      }
      else {
        response.choices[0]!.message.content = '{"city":"杭州"}'
        injectClient(provider, { chat: { completions: { create: captureCreate(captured, response) } } })
      }

      const result = await provider.generateObject({
        ...request,
        schema: z.object({ city: z.string() }),
        reasoning: { effort: 'high' },
      })

      expect(result.object.city).toBe('杭州')
      expect(captured.body).toMatchObject(Adapter === ResponsesProvider
        ? { reasoning: { effort: 'none' } }
        : { reasoning_effort: 'none' })
    },
  )
})
