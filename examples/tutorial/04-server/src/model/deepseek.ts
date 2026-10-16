/**
 * 模型装配：给 Agent 一份可持久化配置和一个能实际发请求的适配器
 *
 * config 描述本次使用的模型和能力，Engine 可以把它写入运行记录
 * adapter 负责调用 DeepSeek 的 Anthropic Messages 接口，凭据只交给适配器
 * 修改提示词不需要改这里；更换供应商或模型能力时才调整本文件
 */
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { UnknownRecord } from '@elmino/shared'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { HttpUrlSchema, TrimmedStringSchema } from '@elmino/schema'
import { createId } from '@elmino/shared'
import { createEnv } from '@t3-oss/env-core'

/** 从示例环境变量装配 DeepSeek 的 Anthropic Messages 接口 */
export function createModel(frozenConfig?: UnknownRecord): TurnModel<ModelTurnConfig> {
  const env = createEnv({
    server: {
      DEEPSEEK_API_KEY: TrimmedStringSchema,
      DEEPSEEK_MODEL: TrimmedStringSchema.default('deepseek-flash'),
      DEEPSEEK_BASE_URL: HttpUrlSchema.default('https://api.deepseek.com/anthropic'),
    },
    runtimeEnv: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY?.trim(),
      // 恢复只校验当前凭据，模型名称与地址以原 Turn 快照为准
      DEEPSEEK_MODEL: frozenConfig ? undefined : process.env.DEEPSEEK_MODEL?.trim(),
      DEEPSEEK_BASE_URL: frozenConfig ? undefined : process.env.DEEPSEEK_BASE_URL?.trim(),
    },
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('请检查示例 .env 中的 DeepSeek 配置，DEEPSEEK_API_KEY 必填')
    },
  })
  // 冻结快照由 Engine 从本示例的模型配置持久化，恢复不读取当前默认模型
  // 新任务读取当前默认模型；恢复时使用原 Turn 的快照，不能静默换模型
  const config: ModelTurnConfig = (frozenConfig as unknown as ModelTurnConfig | undefined) ?? {
    id: 'deepseek', // 对应 Elmino models 注册键，重启后仍能找到原工厂
    providerId: createId('provider'),
    providerName: 'deepseek',
    apiFormat: 'anthropic-messages',
    name: env.DEEPSEEK_MODEL,
    label: 'DeepSeek',
    baseURL: env.DEEPSEEK_BASE_URL,
    cache: { mode: 'disabled' },
    reasoning: { level: 'high', options: { thinking: { type: 'enabled' } } },
    limit: { context: 32_768 },
    inputModalities: [],
    jsonSchema: false,
    apiKeyRequired: true,
  }
  return {
    config,
    // credential 属于本次运行的连接能力，与上面的持久化配置分开
    adapter: AnthropicMessagesProvider.create({
      model: config.name,
      baseURL: config.baseURL,
      providerName: config.providerName,
      credential: env.DEEPSEEK_API_KEY,
      cache: config.cache,
      jsonSchema: config.jsonSchema,
    }),
  }
}
