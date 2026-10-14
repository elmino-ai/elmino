/** -------------------- 核心函数 -------------------- */
/**
 * 从对象中取出指定属性组成新对象
 */
export function objectPick<T extends object, const K extends readonly (keyof T)[]>(
  obj: T,
  ...keys: K
): Pick<T, K[number]> {
  const result = {} as Pick<T, K[number]>

  for (const key of keys)
    result[key] = obj[key]

  return result
}
