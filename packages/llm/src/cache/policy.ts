/** -------------------- 类型 -------------------- */
/** 模型 Provider 公共缓存模式 */
export type CacheMode = 'automatic' | 'disabled' | 'explicit'
/** 可放置缓存断点的稳定请求区域 */
export type CacheBreakpoint = 'latest-user' | 'system' | 'tools'

/** 模型或单次请求选择的缓存模式 */
export interface CachePolicy {
  /** 缓存模式 */
  mode: CacheMode
}

/** Provider 复用策略解析后的缓存控制 */
export interface CacheControl extends CachePolicy {
  /** 当前供应商和消息协议支持的显式断点 */
  breakpoints: CacheBreakpoint[]
}

/** Provider 缓存能力 */
export interface CacheCapability {
  /** Provider 支持的缓存模式 */
  modes: CacheMode[]
  /** Provider 能原生表达的缓存断点区域 */
  breakpoints?: CacheBreakpoint[]
}

/** -------------------- 核心函数 -------------------- */
/**
 * 在 Turn 冻结边界校验缓存模式
 */
export function validateCache(cache: CachePolicy, capability: CacheCapability) {
  const { modes } = capability

  if (!modes.includes(cache.mode))
    throw new Error(`Provider ${cache.mode} 缓存模式不受支持`)
}
