import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { UnknownRecord } from '@elmino/shared'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { createId } from '@elmino/shared'

/** 从示例环境变量装配 DeepSeek 的 Anthropic Messages 接口 */
export function createModel(frozenConfig?: UnknownRecord): TurnModel<ModelTurnConfig> {
  const credential = process.env.DEEPSEEK_API_KEY?.trim()

  if (!credential)
    throw new Error('请在 examples/tutorial/03-server-sdk/.env 中配置 DEEPSEEK_API_KEY')

  const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
  // 冻结快照由 Engine 从本示例的模型配置持久化，恢复不读取当前默认模型
  const config: ModelTurnConfig = (frozenConfig as unknown as ModelTurnConfig | undefined) ?? {
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
  }
  return {
    config,
    adapter: AnthropicMessagesProvider.create({
      model: config.name,
      baseURL: config.baseURL,
      providerName: config.providerName,
      credential,
      cache: config.cache,
      jsonSchema: config.jsonSchema,
    }),
  }
}
