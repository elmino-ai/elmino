/** -------------------- 核心函数 -------------------- */
/**
 * 判断未知值是否属于给定值集合
 */
export function isOneOf<TValue>(
  value: unknown,
  values: readonly TValue[],
): value is TValue {
  for (const item of values) {
    if (item === value)
      return true
  }

  return false
}
