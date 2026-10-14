import type { JsonValue } from 'type-fest'
import { isPlainRecord, objectValues } from '../object/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 判断未知值是否为严格 JSON 值
 */
export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>()
  /** 递归校验 JSON 值，并拒绝循环引用和非有限数字 */
  const visit = (current: unknown): boolean => {
    if (
      current === null
      || typeof current === 'boolean'
      || typeof current === 'string'
    ) {
      return true
    }
    if (typeof current === 'number')
      return Number.isFinite(current)
    if (!Array.isArray(current) && !isPlainRecord(current))
      return false
    if (ancestors.has(current))
      return false

    ancestors.add(current)
    const valid = Array.isArray(current)
      ? current.every(visit)
      : objectValues(current).every(visit)

    ancestors.delete(current)
    return valid
  }

  return visit(value)
}
