import type { Event, ModelTurnConfig, Provider, Request, Result, ToolResultPart, TurnModel } from '@elmino/llm'
import { EMPTY_USAGE } from '@elmino/llm'
import { ResponsesProvider } from '@elmino/llm-openai/responses'
import { createId } from '@elmino/shared'
import * as z from 'zod'

/** 样例支持的确定性演示和真实 OpenAI 模式 */
export type ExampleModelMode = 'demo' | 'openai'

/** Provider 原生调用标识，不属于宿主生成的 opaque ID */
const DEMO_TOOL_CALL_ID = 'demo_write_note'
/** 演示模式的固定内容 */
const DEMO_TEXT = 'Hello from elmino'
/** 演示模式不会连接的接口标识 */
const DEMO_BASE_URL = 'https://demo.elmino.invalid/v1'
/** 两种样例模式共用的可持久化模型字段 */
const commonConfig = {
  id: z.string().min(1),
  providerId: z.string().min(1),
  apiFormat: z.literal('responses'),
  cache: z.strictObject({ mode: z.literal('disabled') }),
  label: z.string().min(1),
  limit: z.strictObject({ context: z.number().int().positive() }),
  inputModalities: z.array(z.literal('image')).max(0),
}
/** 只恢复样例明确支持的模式，不接受凭据或未知模型字段 */
const exampleModelConfig = z.discriminatedUnion('providerName', [
  z.strictObject({
    ...commonConfig,
    providerName: z.literal('demo'),
    name: z.literal('demo'),
    baseURL: z.literal(DEMO_BASE_URL),
    apiKeyRequired: z.literal(false),
    jsonSchema: z.literal(false),
  }),
  z.strictObject({
    ...commonConfig,
    providerName: z.literal('openai'),
    name: z.string().min(1),
    baseURL: z.url().refine((value) => {
      const url = new URL(value)
      return (url.protocol === 'https:' || url.protocol === 'http:')
        && !url.username && !url.password && !url.search && !url.hash
    }, '接口地址只允许不含凭据、查询参数和片段的 HTTP(S) URL'),
    apiKeyRequired: z.literal(true),
    jsonSchema: z.literal(true),
  }),
])

/** 创建可持久化的非敏感配置，API Key 只在恢复适配器时读取 */
export function createModelConfig(mode: ExampleModelMode): ModelTurnConfig {
  const name = mode === 'demo' ? 'demo' : process.env.ELMINO_EXAMPLE_MODEL?.trim()
  if (!name)
    throw new Error('OpenAI 模式需要设置 ELMINO_EXAMPLE_MODEL')

  return exampleModelConfig.parse({
    id: createId('model'),
    providerId: createId('provider'),
    apiFormat: 'responses',
    baseURL: mode === 'demo'
      ? DEMO_BASE_URL
      : process.env.ELMINO_EXAMPLE_BASE_URL?.trim() || 'https://api.openai.com/v1',
    cache: { mode: 'disabled' },
    name,
    label: mode === 'demo' ? 'Elmino Demo' : name,
    limit: { context: 32_768 },
    inputModalities: [],
    apiKeyRequired: mode === 'openai',
    providerName: mode,
    jsonSchema: mode === 'openai',
  })
}

/** 从持久化边界恢复样例模型，凭据只进入真实服务适配器 */
export function restoreExampleModel(value: unknown): TurnModel<ModelTurnConfig> {
  const config = exampleModelConfig.parse(value)
  if (config.providerName === 'demo')
    return { config, adapter: createDemoProvider(config) }

  const credential = process.env.ELMINO_EXAMPLE_API_KEY?.trim()
  if (!credential)
    throw new Error('OpenAI 模式需要设置 ELMINO_EXAMPLE_API_KEY')

  return {
    config,
    adapter: ResponsesProvider.create({
      model: config.name,
      baseURL: config.baseURL,
      providerName: config.providerName,
      credential,
      apiKeyRequired: config.apiKeyRequired,
      cache: config.cache,
      jsonSchema: config.jsonSchema,
    }),
  }
}

/** 演示 Provider 使用真实公共协议并等待观察者完成，不访问外部模型 */
function createDemoProvider(config: ModelTurnConfig): Provider {
  return {
    name: config.providerName,
    model: config.name,
    capabilities: {
      cache: { modes: ['disabled'] },
      reasoning: false,
      tools: true,
      jsonSchema: false,
    },
    generate(request) {
      return new Promise(resolve => resolve(createDemoResult(request)))
    },
    async stream(request, onEvent) {
      const result = createDemoResult(request)
      const events: Event[] = []
      for (const [index, part] of result.message.parts.entries()) {
        const start = part.type === 'tool-call'
          ? { ...part, args: {}, argsText: '' }
          : part.type === 'text' ? { ...part, text: '' } : part
        events.push({ type: 'part-start', index, part: start })
        if (part.type === 'tool-call') {
          events.push({ type: 'part-delta', index, delta: { type: 'tool-args', text: JSON.stringify(part.args) } })
        }
        else if (part.type === 'text') {
          events.push({ type: 'part-delta', index, delta: { type: 'text', text: part.text } })
        }
        events.push({ type: 'part-end', index, part })
      }
      events.push({ type: 'usage', usage: result.usage })
      for (const event of events) {
        request.signal?.throwIfAborted()
        await onEvent?.(event)
      }
      request.signal?.throwIfAborted()
      return result
    },
    generateObject(request) {
      return Promise.reject(request.signal?.aborted
        ? request.signal.reason
        : new Error('Demo 模式不支持结构化对象生成'))
    },
  }
}

/** 根据已经回放的工具结果决定下一次确定性采样 */
function createDemoResult(request: Request): Result {
  request.signal?.throwIfAborted()
  const toolResult = request.messages.flatMap(message => message.parts).findLast((part): part is ToolResultPart => (
    part.type === 'tool-result' && (part.name === 'write_note' || part.callId === DEMO_TOOL_CALL_ID)
  ))
  return {
    message: {
      role: 'assistant',
      finishReason: toolResult ? 'completed' : 'tool-calls',
      parts: toolResult
        ? [{
            type: 'text',
            text: toolResult.error
              ? 'write_note 执行失败，请检查工具结果'
              : `已调用 write_note，写入 ${DEMO_TEXT}`,
          }]
        : [{ type: 'tool-call', id: DEMO_TOOL_CALL_ID, name: 'write_note', args: { text: DEMO_TEXT } }],
    },
    usage: { ...EMPTY_USAGE, input: 1, output: 1 },
  }
}
