import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { createId } from '@elmino/shared'

/** 当前本地示例固定使用 DeepSeek 的 Anthropic Messages 接口 */
export function createModel(): TurnModel<ModelTurnConfig> {
  const modelName = 'deepseek-flash'
  const baseURL = 'https://api.deepseek.com/anthropic'
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
      limit: { context: 32_768 },
      inputModalities: [],
      jsonSchema: false,
      apiKeyRequired: true,
    },
    adapter: AnthropicMessagesProvider.create({
      model: modelName,
      baseURL,
      providerName: 'deepseek',
      credential: 'YOUR_DEEPSEEK_API_KEY',
      cache: { mode: 'disabled' },
      jsonSchema: false,
    }),
  }
}
