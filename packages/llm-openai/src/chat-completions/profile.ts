import { isPlainRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** Chat Completions Provider 与模型的私有协议差异 */
export interface ChatCompletionsProfile {
  /** 最大输出 token 的原生字段 */
  maxOutputField: 'max_completion_tokens' | 'max_tokens'
  /** 是否为历史 assistant 保留空的推理字段 */
  preserveThinking: boolean
  /** 模型必须携带的默认推理参数 */
  reasoning?: Record<string, unknown>
  /** 调用方要求关闭推理时使用的 Provider 参数 */
  disabledReasoning?: Record<string, unknown>
  /** 仅在流式请求中发送的 Provider 顶层参数 */
  streaming?: Record<string, unknown>
  /** Provider 原生结构化输出模式 */
  structuredOutput?: 'json-object'
  /** Provider 工具 Schema 规范化 */
  normalizeToolSchema?: (schema: Record<string, unknown>) => Record<string, unknown>
}

/** Chat Completions Profile 路由输入 */
interface ChatCompletionsProfileRoute {
  /** Provider 原生模型名 */
  model: string
  /** Provider 稳定名称 */
  providerName: string
}

/** -------------------- 常量 -------------------- */
/** 阿里云百炼通用私有协议策略 */
const BAILIAN_PROFILE: ChatCompletionsProfile = {
  maxOutputField: 'max_tokens',
  disabledReasoning: { enable_thinking: false },
  preserveThinking: false,
}

/** -------------------- 核心类 -------------------- */
/**
 * 按供应商和模型选择当前实例的 Chat Completions 协议差异
 */
export function resolveChatProfile(input: ChatCompletionsProfileRoute): ChatCompletionsProfile {
  const { model, providerName } = input

  if (providerName === 'kimi')
    return createKimiProfile(model)
  if (providerName === 'aliyun-bailian')
    return createBailianProfile(model)
  if (providerName === 'bigmodel-coding-plan')
    return createBigModelCodingProfile(model)

  return {
    maxOutputField: providerName === 'openai'
      ? 'max_completion_tokens'
      : 'max_tokens',
    disabledReasoning: providerName === 'openai'
      ? { reasoning_effort: 'none' }
      : providerName === 'deepseek'
        ? { thinking: { type: 'disabled' } }
        : undefined,
    preserveThinking: false,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 解析百炼模型的工具调用和历史思考字段差异
 */
function createBailianProfile(model: string): ChatCompletionsProfile {
  if (model === 'kimi/kimi-k3') {
    return {
      ...BAILIAN_PROFILE,
      preserveThinking: true,
    }
  }

  if (model === 'glm-5.2') {
    return {
      ...BAILIAN_PROFILE,
      streaming: { tool_stream: true },
    }
  }

  return BAILIAN_PROFILE
}

/**
 * 适配 BigModel Coding Plan 的保留式思考、工具流和 JSON Object 模式
 */
function createBigModelCodingProfile(model: string): ChatCompletionsProfile {
  const glm53 = model.startsWith('glm-5.3')
  const thinking = { type: 'enabled', clear_thinking: false }

  return {
    maxOutputField: 'max_tokens',
    preserveThinking: true,
    reasoning: { thinking },
    disabledReasoning: glm53
      ? { thinking, reasoning_effort: 'low' }
      : { thinking: { type: 'disabled', clear_thinking: false } },
    streaming: { tool_stream: true },
    structuredOutput: 'json-object',
  }
}

/**
 * 解析 Kimi 模型私有的思考、缓存和请求字段策略
 */
function createKimiProfile(model: string): ChatCompletionsProfile {
  const k3 = model === 'k3' || model === 'k3-256k'
  const k2 = model === 'kimi-for-coding' || model === 'kimi-for-coding-highspeed'

  return {
    maxOutputField: 'max_completion_tokens',
    disabledReasoning: { thinking: { type: 'disabled' } },
    preserveThinking: k3 || k2,
    reasoning: k3
      ? { thinking: { type: 'enabled', effort: 'max', keep: 'all' } }
      : k2 ? { thinking: { type: 'enabled', keep: 'all' } } : undefined,
    normalizeToolSchema: normalizeKimiToolSchema,
  }
}

/**
 * 补全 Kimi 工具校验要求的嵌套 JSON Schema 类型
 */
function normalizeKimiToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(schema)

  normalizeKimiSchema(normalized)
  return normalized
}

/**
 * 递归规范化 Kimi 工具 Schema 的属性、数组元素与组合分支
 */
function normalizeKimiSchema(value: unknown, inferType = false) {
  if (!isPlainRecord(value))
    return

  if (inferType && typeof value.type !== 'string')
    value.type = inferKimiSchemaType(value)

  const properties = isPlainRecord(value.properties)
    ? value.properties
    : undefined

  for (const property of Object.values(properties ?? {}))
    normalizeKimiSchema(property, true)

  normalizeKimiSchema(value.items)

  for (const variants of [value.allOf, value.anyOf, value.oneOf]) {
    if (Array.isArray(variants)) {
      for (const variant of variants)
        normalizeKimiSchema(variant)
    }
  }
}

/**
 * 从结构关键词推断 Kimi 要求的 JSON Schema 类型
 */
function inferKimiSchemaType(schema: Record<string, unknown>) {
  if (isPlainRecord(schema.properties) || Array.isArray(schema.required))
    return 'object'
  if (schema.items !== undefined)
    return 'array'

  const values = Array.isArray(schema.enum)
    ? schema.enum
    : schema.const === undefined ? [] : [schema.const]
  const kinds = new Set(values.map(value => (
    value === null
      ? 'null'
      : Number.isInteger(value) ? 'integer' : typeof value
  )))

  for (const kind of kinds) {
    if (kinds.size === 1)
      return kind
  }

  return 'string'
}
