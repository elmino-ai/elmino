import {
  deepMerge,
  delay,
  isJsonValue,
  KeyedMutex,
  objectEntries,
  objectFromEntries,
  objectKeys,
  objectOmit,
  objectPick,
  objectValues,
} from '@elmino/shared'
import { expect, test } from 'vitest'

test('deepMerge recursively merges plain objects and replaces arrays', () => {
  const merged = deepMerge(
    {
      nested: {
        enabled: true,
        keep: 'left',
      },
      list: [{ left: 1 }],
    },
    {
      nested: {
        keep: undefined,
        name: 'right',
      },
      list: [{ right: 2 }],
    },
  )
  const keep: string = merged.nested.keep
  const name: string = merged.nested.name

  expect(keep).toBe('left')
  expect(name).toBe('right')
  expect(merged).toEqual({
    nested: {
      enabled: true,
      keep: 'left',
      name: 'right',
    },
    list: [{ right: 2 }],
  })
})

test('deepMerge ignores prototype pollution keys', () => {
  const source = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as object
  const merged = deepMerge({}, source)

  expect(merged).toEqual({ safe: 1 })
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
})

test('object helpers preserve key and value types while projecting objects', () => {
  const source = {
    count: 1,
    label: 'example',
  } as const
  const entries = objectEntries(source)
  const keys = objectKeys(source)
  const values = objectValues(source)
  const rebuilt = objectFromEntries(entries)
  const picked = objectPick(source, 'count')
  const omitted = objectOmit(source, 'label')
  const entry: ['count' | 'label', 1 | 'example'] = entries[0]!
  const key: 'count' | 'label' = keys[0]!
  const value: 1 | 'example' = values[0]!

  expect(entries).toEqual([['count', 1], ['label', 'example']])
  expect(values).toEqual([1, 'example'])
  expect(entry).toEqual(['count', 1])
  expect(key).toBe('count')
  expect(value).toBe(1)
  expect(rebuilt).toEqual(source)
  expect(picked).toEqual({ count: 1 })
  expect(omitted).toEqual({ count: 1 })
})

test('isJsonValue rejects values outside the strict JSON domain', () => {
  const cyclic: Record<string, unknown> = {}

  cyclic.self = cyclic

  expect(isJsonValue({ nested: [null, true, 1, 'text'] })).toBe(true)
  expect(isJsonValue({ value: undefined })).toBe(false)
  expect(isJsonValue({ value: Number.NaN })).toBe(false)
  expect(isJsonValue({ value: Number.POSITIVE_INFINITY })).toBe(false)
  expect(isJsonValue({ value: 1n })).toBe(false)
  expect(isJsonValue(new Date())).toBe(false)
  expect(isJsonValue(cyclic)).toBe(false)
})

test('keyed mutex serializes matching keys and releases after errors', async () => {
  const mutex = new KeyedMutex()
  const calls: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = mutex.runExclusive('same', async () => {
    calls.push('first:start')
    await firstGate
    calls.push('first:end')
  })
  const second = mutex.runExclusive('same', () => {
    calls.push('second')
  })
  const third = mutex.runExclusive('same', () => {
    calls.push('third')
  })
  const other = mutex.runExclusive('other', () => {
    calls.push('other')
  })

  await other
  expect(calls).toEqual(['first:start', 'other'])

  releaseFirst?.()
  await Promise.all([first, second, third])
  expect(calls).toEqual([
    'first:start',
    'other',
    'first:end',
    'second',
    'third',
  ])

  const syncFailure = mutex.runExclusive('failure', () => {
    throw new Error('expected')
  })
  const afterSyncFailure = mutex.runExclusive(
    'failure',
    () => 'released after sync failure',
  )

  await expect(syncFailure).rejects.toThrow('expected')
  await expect(afterSyncFailure).resolves.toBe('released after sync failure')

  const asyncFailure = mutex.runExclusive('failure', async () => {
    await delay(0)
    throw new Error('expected async')
  })
  const afterAsyncFailure = mutex.runExclusive(
    'failure',
    () => 'released after async failure',
  )

  await expect(asyncFailure).rejects.toThrow('expected async')
  await expect(afterAsyncFailure).resolves.toBe('released after async failure')
})
