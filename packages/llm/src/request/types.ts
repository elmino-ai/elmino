import type { CachePolicy } from '../cache/index.js'
import type { Message, TextPart } from '../message/index.js'
import type { Usage } from '../usage/index.js'

/** -------------------- 类型 -------------------- */
/** Provider 可调用的工具声明 */
export interface Tool {
  /** 工具名称 */
  name: string
  /** 工具说明 */
  description?: string
  /** 工具参数 JSON Schema */
  schema: Record<string, unknown>
}

/** 结构化输出约束 */
export interface ResponseFormat {
  /** 输出格式类型 */
  type: 'json-schema'
  /** JSON Schema 名称 */
  name: string
  /** JSON Schema */
  schema: Record<string, unknown>
}

/** 单次 Provider 请求 */
export interface Request {
  /** 稳定系统提示词 */
  system: TextPart[]
  /** 有序对话历史 */
  messages: Message[]
  /** 本轮可调用工具 */
  tools?: Tool[]
  /** 最大输出 token 数 */
  maxOutputTokens: number
  /** 采样温度 */
  temperature?: number
  /** Top-P 采样参数 */
  topP?: number
  /** Provider 原生推理参数，或要求适配器显式关闭推理 */
  reasoning?: Record<string, unknown> | 'disabled'
  /** Provider 内部默认缓存策略的可选请求级覆盖 */
  cache?: CachePolicy
  /** 由调用方维护、供支持的 Provider 路由前缀缓存的稳定键 */
  cacheKey?: string
  /** 结构化输出约束 */
  responseFormat?: ResponseFormat
  /** 外部取消信号 */
  signal?: AbortSignal
}

/** 完整生成结果；message 是本次 sampling 唯一可回放的终态事实 */
export interface Result {
  /** 标准化 assistant 消息 */
  message: Message
  /** Provider 最终累计 Usage */
  usage: Usage
}
