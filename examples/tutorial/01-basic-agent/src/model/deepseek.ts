import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { createId } from '@elmino/shared'

/** 从示例环境变量装配 DeepSeek 的 Anthropic Messages 接口 */
export function createModel(): TurnModel<ModelTurnConfig> {
  const credential = process.env.DEEPSEEK_API_KEY?.trim()

  if (!credential)
    throw new Error('请在 examples/tutorial/01-basic-agent/.env 中配置 DEEPSEEK_API_KEY')

  const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
  return {
    config: {
      id: createId('model'),
      providerId: createId('provider'),
      providerName: 'deepseek',
      apiFormat: 'anthropic-messages',
      name: modelName,
      label: 'DeepSeek',
      baseURL,
      cache: { mode: 'disabled' },
      reasoning: { level: 'high', options: { thinking: { type: 'enabled' } } },
      limit: { context: 32_768 },
      inputModalities: [],
      jsonSchema: false,
      apiKeyRequired: true,
    },
    adapter: AnthropicMessagesProvider.create({
      model: modelName,
      baseURL,
      providerName: 'deepseek',
      credential,
      cache: { mode: 'disabled' },
      jsonSchema: false,
    }),
  }
}
