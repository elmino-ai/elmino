/** -------------------- 核心函数 -------------------- */
/**
 * 返回保留对象值类型的可枚举属性值
 */
export function objectValues<T extends object>(obj: T) {
  return Object.values(obj) as Array<T[keyof T & string]>
}
