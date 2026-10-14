import type { CachePolicy } from '../cache/index.js'

/** 模型接口的显式认证方式 */
export type ProviderAuth = {
  /** 认证头类型 */
  type: 'api-key' | 'bearer'
  /** 认证凭据 */
  credential: string
} | {
  /** 免认证接口 */
  type: 'none'
}

/** 创建一个绑定模型的适配器 */
export interface ProviderOptions {
  /** Provider 原生模型名 */
  model: string
  /** 兼容服务的接口地址 */
  baseURL?: string
  /** 供应商名称，用于选择其协议差异 */
  providerName?: string
  /** 供应商认证凭据 */
  credential?: string
  /** false 表示免认证，缺省表示需要认证 */
  apiKeyRequired?: boolean
  /** 显式覆盖供应商的默认认证类型 */
  auth?: ProviderAuth
  /** 默认请求缓存策略 */
  cache?: CachePolicy
  /** 是否支持原生 JSON Schema，缺省为 true */
  jsonSchema?: boolean
}

/**
 * 在适配器入口解析认证，免认证时不读取或传递凭据
 */
export function resolveProviderAuth(
  options: ProviderOptions,
  defaultType: 'api-key' | 'bearer',
  providerName: string,
): ProviderAuth {
  const { apiKeyRequired, auth, credential } = options

  if (apiKeyRequired === false)
    return { type: 'none' }
  if (auth)
    return auth
  if (!credential)
    throw new Error(`请先为 ${providerName} 配置 API Key`)
  return { type: defaultType, credential }
}
