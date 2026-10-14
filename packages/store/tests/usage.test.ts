import { createTokenUsage, mergeTokenUsage } from '@elmino/store'
import { expect, test } from 'vitest'

test('用量归一化限制推理、缓存与估算计数，并从原始计数重算派生指标', () => {
  expect(createTokenUsage({
    input: 100.9,
    output: 20.8,
    reasoning: 80,
    cacheWrite: 180,
    cacheRead: 160,
    estimated: 150,
    total: 999,
    cacheHitRate: 999,
  })).toEqual({
    input: 100,
    output: 20,
    reasoning: 20,
    cacheWrite: 100,
    cacheRead: 100,
    estimated: 120,
    total: 120,
    cacheHitRate: 1,
  })
})

test('空用量及无效计数不会产生 NaN、负数或无限缓存比例', () => {
  expect(createTokenUsage({
    input: Number.NaN,
    output: Number.POSITIVE_INFINITY,
    reasoning: -1,
    cacheWrite: Number.NEGATIVE_INFINITY,
    cacheRead: 12,
    estimated: 5,
  })).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheWrite: 0,
    cacheRead: 0,
    estimated: 0,
    total: 0,
    cacheHitRate: 0,
  })
  expect(createTokenUsage()).toEqual(createTokenUsage({ input: 0, output: 0 }))
})

test('聚合先对每次 sampling 应用上限，再按累计输入重新计算缓存命中比例', () => {
  const first = createTokenUsage({ input: 10, output: 2, cacheRead: 100, reasoning: 80 })
  const second = { input: 90, output: 8, cacheRead: 0, reasoning: 0 }
  const merged = mergeTokenUsage(first, second)

  expect(merged).toMatchObject({ input: 100, output: 10, reasoning: 2, cacheRead: 10, total: 110, cacheHitRate: 0.1 })
  expect(first).toMatchObject({ input: 10, reasoning: 2, cacheRead: 10, cacheHitRate: 1 })
  expect(mergeTokenUsage(undefined, second)).toEqual(createTokenUsage(second))
})
