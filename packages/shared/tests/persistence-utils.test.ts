import { createId, jsonParse, objectPick } from '@elmino/shared'
import { expect, test } from 'vitest'

test('createId preserves its domain prefix and creates distinct UUID v4 identities', () => {
  const first: `thread_${string}` = createId('thread')
  const second = createId('thread')

  expect(first).toMatch(/^thread_[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)
  expect(first).not.toBe(second)
})

test('jsonParse decodes persisted JSON and keeps false or zero values', () => {
  expect(jsonParse('{"thread":"thread_1","parts":[]}')).toEqual({ thread: 'thread_1', parts: [] })
  expect(jsonParse('false', true)).toBe(false)
  expect(jsonParse('0', 1)).toBe(0)
  expect(jsonParse('""', 'fallback')).toBe('')
})

test('jsonParse applies defaults to missing, null and malformed values', () => {
  const fallback = { parts: [] }

  expect(jsonParse('{broken')).toBeUndefined()
  expect(jsonParse('{broken', fallback)).toBe(fallback)
  expect(jsonParse('null', fallback)).toBe(fallback)
  expect(jsonParse(null, fallback)).toBe(fallback)
  expect(jsonParse(undefined, fallback)).toBe(fallback)
  expect(jsonParse(fallback)).toBe(fallback)
})

test('objectPick projects requested keys while preserving their types and source', () => {
  const symbol = Symbol('metadata')
  const source = { count: 1, label: 'example', [symbol]: false } as const
  const picked = objectPick(source, 'count', symbol)
  const count: 1 = picked.count
  const metadata: false = picked[symbol]

  expect(picked).toEqual({ count: 1, [symbol]: false })
  expect(count).toBe(1)
  expect(metadata).toBe(false)
  expect(Object.hasOwn(source, 'label')).toBe(true)
  expect(Object.hasOwn(picked, 'label')).toBe(false)
  expect(objectPick(source)).toEqual({})
})
