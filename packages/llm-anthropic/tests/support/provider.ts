import type { CachePolicy, Provider, Request } from '@elmino/llm'

/** -------------------- 类型 -------------------- */
/** 测试替身捕获的 Provider 原生请求 */
export interface CapturedRequest {
  /** 最近一次原生请求体 */
  body?: Record<string, unknown>
}

/** -------------------- 常量 -------------------- */
/** 三类 Provider 共用的统一请求 */
export const request: Request = {
  system: [{ type: 'text', text: '稳定系统提示' }],
  messages: [{
    role: 'user',
    parts: [{ type: 'text', text: '读取天气' }],
  }],
  tools: [{
    name: 'weather',
    description: '读取天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
  maxOutputTokens: 1024,
}

/** 显式缓存的具体断点由供应商和消息协议策略决定 */
export const explicitCache = { mode: 'explicit' } satisfies CachePolicy

/** 仅依赖供应商自动前缀复用的测试模型缓存配置 */
export const automaticCache = { mode: 'automatic' } satisfies CachePolicy

/**
 * 将 SDK 客户端替换为只在测试中使用的内存替身
 */
export function injectClient(provider: Provider, client: object) {
  Reflect.set(provider, '_client', client)
}

/**
 * 捕获原生请求体并返回固定响应
 */
export function captureCreate(captured: CapturedRequest, response: object) {
  return (body: Record<string, unknown>) => {
    captured.body = body
    return Promise.resolve(response)
  }
}

/**
 * 创建可选择在末尾抛错的异步事件序列
 */
export function asyncIterable<T>(items: T[], error?: Error) {
  return {
    async* [Symbol.asyncIterator]() {
      for (const item of items)
        yield item
      if (error)
        throw error
    },
  }
}
