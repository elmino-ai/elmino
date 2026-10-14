import { deepEqual, isPlainRecord } from '@elmino/shared'
import { expect, test } from 'vitest'

test('isPlainRecord accepts plain and null-prototype objects and rejects other values', () => {
  class Example {}

  expect(isPlainRecord({})).toBe(true)
  expect(isPlainRecord(Object.create(null))).toBe(true)
  expect(isPlainRecord([])).toBe(false)
  expect(isPlainRecord(new Date())).toBe(false)
  expect(isPlainRecord(new Example())).toBe(false)
  expect(isPlainRecord(null)).toBe(false)
  expect(isPlainRecord('value')).toBe(false)
})

test('deepEqual compares nested arrays and plain objects independently of key order', () => {
  expect(deepEqual(
    { enabled: true, nested: [{ count: 1, label: 'value' }] },
    { nested: [{ label: 'value', count: 1 }], enabled: true },
  )).toBe(true)
  expect(deepEqual({ value: undefined }, {})).toBe(false)
  expect(deepEqual([1, 2], [1, 3])).toBe(false)
  expect(deepEqual([1], [1, 2])).toBe(false)
  expect(deepEqual([1], { 0: 1 })).toBe(false)
})

test('deepEqual compares symbol and non-enumerable properties of plain objects', () => {
  const symbol = Symbol('metadata')
  const left = Object.defineProperty({ [symbol]: 'first' }, 'hidden', { value: 1 })
  const right = Object.defineProperty({ [symbol]: 'first' }, 'hidden', { value: 1 })

  expect(deepEqual(left, right)).toBe(true)
  expect(deepEqual(left, { [symbol]: 'first' })).toBe(false)
  right[symbol] = 'second'
  expect(deepEqual(left, right)).toBe(false)
})

test('deepEqual compares null-prototype records and keeps non-plain instances by identity', () => {
  const record = Object.assign(Object.create(null), { nested: { count: 1 } })
  const date = new Date(0)

  expect(deepEqual(record, { nested: { count: 1 } })).toBe(true)
  expect(deepEqual(date, date)).toBe(true)
  expect(deepEqual(date, new Date(0))).toBe(false)
  expect(deepEqual(new Map([['key', 1]]), new Map([['key', 1]]))).toBe(false)
})
