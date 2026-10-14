/** -------------------- 核心函数 -------------------- */
/**
 * 从对象中移除指定属性组成新对象
 */
export function objectOmit<T extends object, const K extends readonly (keyof T)[]>(
  obj: T,
  ...keys: K
): Omit<T, K[number]> {
  const result = { ...obj }

  for (const key of keys)
    delete result[key]

  return result
}
