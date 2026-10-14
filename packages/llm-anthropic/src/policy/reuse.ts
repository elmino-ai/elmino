import type { CacheCapability, CachePolicy, RequestCache } from '@elmino/llm/cache'
import { RequestCache as Cache } from '@elmino/llm/cache'

/** Anthropic 缓存约束与原生自动缓存开关 */
export interface ProviderReuseStrategy extends RequestCache {
  /** 是否发送顶层自动缓存控制 */
  automaticControl: boolean
}

/** Anthropic 原生显式断点 */
const EXPLICIT_CACHE: CacheCapability = {
  modes: ['automatic', 'disabled', 'explicit'],
  breakpoints: ['tools', 'system', 'latest-user'],
}
/** 兼容端点只接受服务端隐式缓存 */
const IMPLICIT_CACHE: CacheCapability = {
  modes: ['automatic', 'disabled'],
}

/**
 * 将兼容端点的缓存差异限制在 Anthropic 适配器中
 */
export function resolveReuse(defaultCache: CachePolicy, model: string, providerName: string) {
  const implicit = providerName === 'deepseek' || providerName === 'mimo'
    || (providerName === 'minimax' && !model.startsWith('MiniMax-M2.7'))
  const cache = implicit ? IMPLICIT_CACHE : EXPLICIT_CACHE
  const automaticControl = !implicit

  return Object.assign(Cache.create({ cache, defaultCache }), { automaticControl })
}
