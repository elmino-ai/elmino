import type { CacheCapability, CachePolicy, RequestCache } from '@elmino/llm/cache'
import { RequestCache as Cache } from '@elmino/llm/cache'

/** Provider 复用策略配置 */
interface ReuseConfig {
  /** Provider 可接受的请求级缓存配置 */
  cache: CacheCapability
  /** 调用方未覆盖时使用的缓存策略 */
  defaultCache: CachePolicy
  /** 是否发送协议原生的自动缓存控制字段 */
  automaticControl?: boolean
  /** 是否发送稳定的 Prompt Cache 路由键 */
  promptCacheKey?: boolean
  /** Responses 是否使用服务端会话续接 */
  responseSession?: 'bailian' | 'openai'
}

/** 适配器请求复用策略 */
export interface ProviderReuseStrategy extends RequestCache {
  /** 是否发送自动缓存控制 */
  automaticControl: boolean
  /** 是否发送缓存路由键 */
  promptCacheKey: boolean
  /** Responses 原生会话实现 */
  responseSession?: 'bailian' | 'openai'
}

/** -------------------- 常量 -------------------- */
/** 支持显式断点的通用缓存能力 */
const CONTENT_CACHE: CacheCapability = {
  modes: ['automatic', 'disabled', 'explicit'],
  breakpoints: ['system', 'latest-user'],
}
/** 仅依赖服务端隐式前缀缓存的能力 */
const IMPLICIT_CACHE: CacheCapability = {
  modes: ['automatic', 'disabled'],
}

/**
 * 为当前供应商和消息协议选择请求复用规则
 */
export function resolveReuse(
  apiFormat: 'chat-completions' | 'responses',
  defaultCache: CachePolicy,
  providerName: string,
) {
  if (apiFormat === 'responses' && (providerName === 'openai' || providerName === 'aliyun-bailian')) {
    return createReuse({
      cache: CONTENT_CACHE,
      defaultCache,
      automaticControl: true,
      promptCacheKey: true,
      responseSession: providerName === 'aliyun-bailian' ? 'bailian' : 'openai',
    })
  }
  if (apiFormat === 'responses') {
    return createReuse({
      cache: IMPLICIT_CACHE,
      defaultCache,
    })
  }
  if (providerName === 'kimi' && apiFormat === 'chat-completions') {
    return createReuse({
      cache: IMPLICIT_CACHE,
      defaultCache,
      promptCacheKey: true,
    })
  }
  if (providerName === 'aliyun-bailian' && apiFormat === 'chat-completions') {
    return createReuse({
      cache: CONTENT_CACHE,
      defaultCache,
    })
  }
  if (providerName === 'openai' && apiFormat === 'chat-completions') {
    return createReuse({
      cache: IMPLICIT_CACHE,
      defaultCache,
      promptCacheKey: true,
    })
  }

  // 其他 Chat 兼容服务不发送供应商私有字段；automatic 只表达服务端可自行复用相同前缀。
  return createReuse({
    cache: IMPLICIT_CACHE,
    defaultCache,
  })
}

/**
 * 在公共缓存约束上装配当前协议的私有能力
 */
function createReuse(config: ReuseConfig): ProviderReuseStrategy {
  const { cache, defaultCache, automaticControl = false, promptCacheKey = false, responseSession } = config

  return Object.assign(Cache.create({ cache, defaultCache }), {
    automaticControl,
    promptCacheKey,
    responseSession,
  })
}
