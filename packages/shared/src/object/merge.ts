import { isPlainRecord } from './record.js'

/** -------------------- 类型 -------------------- */
/** 可深合并的普通对象 */
type PlainRecord = Record<PropertyKey, unknown>

/** undefined 不覆盖已有目标字段的值类型 */
type MergeValue<T, U> = undefined extends U
  ? DeepMerge<T, Exclude<U, undefined>> | T
  : DeepMerge<T, U>

/** 两个对象深合并后的类型 */
export type DeepMerge<T, U> = U extends readonly unknown[]
  ? U
  : T extends object
    ? U extends object
      ? {
          [K in keyof T | keyof U]: K extends keyof U
            ? K extends keyof T
              ? MergeValue<T[K], U[K]>
              : U[K]
            : K extends keyof T
              ? T[K]
              : never
        }
      : U
    : U

/** -------------------- 常量 -------------------- */
/** 不允许通过合并写入的危险 key */
const unsafeKeys = new Set<PropertyKey>([
  '__proto__',
  'constructor',
  'prototype',
])

/** -------------------- 核心函数 -------------------- */
/**
 * 深合并普通对象，数组和值由后者覆盖
 */
export function deepMerge<T extends object, U extends object>(
  target: T,
  source: U,
): DeepMerge<T, U>

/**
 * 深合并普通对象，数组和值由后者覆盖
 */
export function deepMerge<
  T extends object,
  U extends object,
  V extends object,
>(
  target: T,
  source: U,
  next: V,
): DeepMerge<DeepMerge<T, U>, V>

/**
 * 深合并普通对象，数组和值由后者覆盖
 */
export function deepMerge<T extends object>(
  target: T,
  ...sources: object[]
) {
  return sources.reduce<PlainRecord>(
    (result, source) => mergeRecord(result, source as PlainRecord),
    cloneValue(target) as PlainRecord,
  )
}

/** -------------------- 内部函数 -------------------- */
/**
 * 合并单个普通对象
 */
function mergeRecord(target: PlainRecord, source: PlainRecord): PlainRecord {
  const result = cloneValue(target) as PlainRecord

  for (const key of Reflect.ownKeys(source)) {
    if (unsafeKeys.has(key))
      continue

    const value = source[key]

    // 和 lodash merge 保持一致：已有目标值时，undefined 不覆盖
    if (value === undefined && key in result)
      continue

    const current = result[key]

    result[key] = isPlainRecord(current) && isPlainRecord(value)
      ? mergeRecord(current, value)
      : cloneValue(value)
  }

  return result
}

/**
 * 克隆深合并涉及的普通对象和数组
 */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value))
    return value.map(item => cloneValue(item)) as T

  if (!isPlainRecord(value))
    return value

  const cloned: PlainRecord = {}

  for (const key of Reflect.ownKeys(value)) {
    if (!unsafeKeys.has(key))
      cloned[key] = cloneValue(value[key])
  }

  return cloned as T
}
