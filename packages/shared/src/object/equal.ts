import { isPlainRecord } from './record'

/** -------------------- 核心函数 -------------------- */
/**
 * 深度比较由原始值、数组和普通对象组成的数据
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right))
    return true

  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]))
  }

  if (!isPlainRecord(left) || !isPlainRecord(right))
    return false

  const keys = Reflect.ownKeys(left)

  return keys.length === Reflect.ownKeys(right).length
    && keys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}
