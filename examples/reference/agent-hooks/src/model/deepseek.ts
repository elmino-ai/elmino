/**
 * 模型装配：给 Agent 一份可持久化配置和一个能实际发请求的适配器
 *
 * config 描述本次使用的模型和能力，Engine 可以把它写入运行记录
 * adapter 负责调用 DeepSeek 的 Anthropic Messages 接口，凭据只交给适配器
 * 修改提示词不需要改这里；更换供应商或模型能力时才调整本文件
 */
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { createId } from '@elmino/shared'

/** 从示例环境变量装配 DeepSeek 的 Anthropic Messages 接口 */
export function createModel(): TurnModel<ModelTurnConfig> {
  const credential = process.env.DEEPSEEK_API_KEY?.trim()

  if (!credential)
    throw new Error('请在 examples/reference/agent-hooks/.env 中配置 DEEPSEEK_API_KEY')

  const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
  return {
    // 这里只保存非敏感模型信息，API Key 不进入 config 或 SQLite
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
    // credential 属于本次运行的连接能力，与上面的持久化配置分开
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
