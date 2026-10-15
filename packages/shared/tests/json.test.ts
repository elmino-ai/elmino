import { isJsonValue } from '@elmino/shared'
import { expect, test } from 'vitest'

test('JSON 数组拒绝稀疏槽和 undefined，避免传输时静默变成 null', () => {
  const sparse: unknown[] = ['value']
  sparse.length = 2
  expect(isJsonValue(sparse)).toBe(false)
  expect(isJsonValue({ nested: sparse })).toBe(false)
  expect(isJsonValue([undefined])).toBe(false)
  expect(isJsonValue(['value', null])).toBe(true)
})
