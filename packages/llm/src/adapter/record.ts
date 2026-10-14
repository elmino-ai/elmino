/** -------------------- 核心函数 -------------------- */
/**
 * 判断未知值是否为普通对象
 */
export function isPlainRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}
