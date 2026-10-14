import type { CacheMode } from '../cache/index.js'

/** -------------------- 类型 -------------------- */
/** 单次 Turn 冻结的推理策略，原生请求参数由适配器解释 */
export interface ModelTurnReasoning {
  /** 宿主提供的推理强度名称 */
  level: string
  /** 当前强度的 Provider 原生请求参数 */
  options: Record<string, unknown>
}

/** 可持久化、可由宿主恢复的非敏感模型配置，不包含凭据或 SDK 实例 */
export interface ModelTurnConfig {
  /** 宿主提供的模型配置稳定 ID */
  id: string
  /** 模型使用的消息协议格式 */
  apiFormat: 'anthropic-messages' | 'chat-completions' | 'responses'
  /** 模型接口地址 */
  baseURL: string
  /** 模型默认缓存策略 */
  cache: { mode: CacheMode }
  /** Provider 原生模型名称 */
  name: string
  /** 宿主提供的模型展示名称 */
  label: string
  /** 最大上下文 token 数 */
  limit: { context: number }
  /** 是否支持原生 JSON Schema */
  jsonSchema: boolean
  /** 当前模型支持的额外输入模态 */
  inputModalities: 'image'[]
  /** Provider 是否需要 API Key，恢复时由宿主按此选择认证 */
  apiKeyRequired?: boolean
  /** 宿主提供的 Provider 配置稳定 ID */
  providerId: string
  /** Provider 稳定名称，用于恢复适配策略 */
  providerName: string
  /** Turn 启动时冻结的推理策略 */
  reasoning?: ModelTurnReasoning
}
