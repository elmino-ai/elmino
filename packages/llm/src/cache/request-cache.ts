import type { Request } from '../request/index'
import type { CacheCapability, CacheControl, CachePolicy } from './policy'
import { validateCache } from './policy'

/** 请求默认缓存与能力约束 */
interface RequestCacheConfig {
  /** 可接受的请求缓存能力 */
  cache: CacheCapability
  /** 未覆盖时使用的策略 */
  defaultCache: CachePolicy
}

/**
 * 保存单个 Provider 与消息协议组合的请求复用规则
 */
export class RequestCache {
  /** Provider 对外声明的缓存能力 */
  public readonly cache: CacheCapability
  /** 调用方未覆盖时使用的缓存策略 */
  private readonly _defaultCache: CachePolicy

  /**
   * 创建独立的 Provider 复用策略
   */
  public static create(config: RequestCacheConfig) {
    return new RequestCache(config)
  }

  /**
   * 保存已经路由完成的复用规则
   */
  private constructor(config: RequestCacheConfig) {
    const {
      cache,
      defaultCache,
    } = config

    this.cache = structuredClone(cache)
    this._defaultCache = { ...defaultCache }
    validateCache(defaultCache, cache)
  }

  /**
   * 应用 Provider 默认值并校验单次请求覆盖
   */
  public resolve(request: Request): Request & { cache: CacheControl } {
    const requested = request.cache ?? this._defaultCache

    validateCache(requested, this.cache)
    const cache: CacheControl = {
      mode: requested.mode,
      breakpoints: requested.mode === 'explicit'
        ? [...(this.cache.breakpoints ?? [])]
        : [],
    }

    return { ...request, cache }
  }
}
