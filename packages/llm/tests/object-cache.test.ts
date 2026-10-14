import type { Request, Result } from '@elmino/llm'
import { EMPTY_USAGE, ObjectParseError, parseObject } from '@elmino/llm'
import { RequestCache } from '@elmino/llm/cache'
import { resolveProviderAuth } from '@elmino/llm/provider'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

describe('结构化输出与请求边界', () => {
  test.each(['{"city":"杭州"}', '```json\n{"city":"杭州"}\n```', '结果：{"city":"杭州"}'])(
    '结构化结果由调用方 Schema 校验：%s',
    (text) => {
      const result: Result = {
        message: { role: 'assistant', parts: [{ type: 'text', text }] },
        usage: EMPTY_USAGE,
      }

      expect(parseObject(result, z.object({ city: z.string() })).object).toEqual({ city: '杭州' })
    },
  )

  test('Schema 失败保留已完成的模型响应和解析原因', () => {
    const result: Result = {
      message: { role: 'assistant', parts: [{ type: 'text', text: '{"city":42}' }] },
      usage: EMPTY_USAGE,
    }

    try {
      parseObject(result, z.object({ city: z.string() }))
      throw new Error('应拒绝不满足 Schema 的响应')
    }
    catch (error) {
      expect(error).toBeInstanceOf(ObjectParseError)
      expect((error as ObjectParseError).result).toBe(result)
      expect((error as ObjectParseError).cause).toBeInstanceOf(z.ZodError)
    }
  })

  test('缓存覆盖只影响当前请求，显式断点来自适配器能力', () => {
    const cache = RequestCache.create({
      defaultCache: { mode: 'automatic' },
      cache: { modes: ['automatic', 'disabled', 'explicit'], breakpoints: ['system'] },
    })
    const request: Request = { system: [], messages: [], maxOutputTokens: 10 }

    expect(cache.resolve({ ...request, cache: { mode: 'explicit' } }).cache)
      .toEqual({ mode: 'explicit', breakpoints: ['system'] })
    expect(cache.resolve(request).cache).toEqual({ mode: 'automatic', breakpoints: [] })
  })

  test('免认证优先于保存的凭据和显式认证，不向适配器泄漏密钥', () => {
    expect(resolveProviderAuth({
      model: 'local',
      apiKeyRequired: false,
      credential: 'test-key',
      auth: { type: 'bearer', credential: 'other-test-key' },
    }, 'bearer', 'local')).toEqual({ type: 'none' })
  })

  test('实例保存自己的缓存能力和默认值，不跟随宿主后续修改', () => {
    const defaultCache = { mode: 'automatic' } as const
    const capability = { modes: ['automatic', 'disabled'] as Array<'automatic' | 'disabled'> }
    const cache = RequestCache.create({ defaultCache, cache: capability })

    capability.modes.splice(0)
    Object.assign(defaultCache, { mode: 'disabled' })

    expect(cache.resolve({ system: [], messages: [], maxOutputTokens: 10 }).cache.mode)
      .toBe('automatic')
    expect(cache.cache.modes).toEqual(['automatic', 'disabled'])
  })
})
