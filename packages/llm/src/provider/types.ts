import type { z } from 'zod'
import type { CacheCapability } from '../cache/index.js'
import type { ObjectResult } from '../object/index.js'
import type { Request, Result } from '../request/index.js'
import type { EventHandler } from '../stream/index.js'

/** -------------------- 类型 -------------------- */
/** Provider 能力声明 */
export interface ProviderCapabilities {
  /** Prompt Cache 能力 */
  cache: CacheCapability
  /** 是否支持推理输出 */
  reasoning: boolean
  /** 是否支持工具调用 */
  tools: boolean
  /** 是否支持 Provider 原生 JSON Schema */
  jsonSchema: boolean
}

/** Provider 原生 token 计数输入 */
export type CountTokensRequest = Pick<Request, 'messages' | 'system' | 'tools'>

/** 跨厂商统一的模型 Provider */
export interface Provider {
  /** Provider 稳定名称 */
  readonly name: string
  /** Provider 原生模型名称 */
  readonly model: string
  /** 当前 Provider 与模型能力 */
  readonly capabilities: ProviderCapabilities
  /** 使用原生接口统计请求 token，不支持时返回 undefined */
  countTokens?: (request: CountTokensRequest) => Promise<number | undefined>
  /** 非流式生成 */
  generate: (request: Request) => Promise<Result>
  /** 流式生成并投影统一事件 */
  stream: (request: Request, onEvent?: EventHandler) => Promise<Result>
  /** 按 Zod Schema 生成结构化对象 */
  generateObject: <TSchema extends z.ZodType>(
    request: Omit<Request, 'responseFormat'> & { schema: TSchema, schemaName?: string },
  ) => Promise<ObjectResult<TSchema>>
}

/** 单次 Turn 冻结的模型配置和 Provider */
export interface TurnModel<TConfig = unknown> {
  /** 可持久化的非敏感模型配置 */
  readonly config: TConfig
  /** 已绑定 Provider 和模型名的调用适配器 */
  readonly adapter: Provider
}
