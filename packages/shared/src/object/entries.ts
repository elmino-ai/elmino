/** -------------------- 核心函数 -------------------- */
/**
 * 返回保留对象键值类型的可枚举属性条目
 */
export function objectEntries<T extends object>(obj: T) {
  return Object.entries(obj) as Array<[
    keyof T & string,
    T[keyof T & string],
  ]>
}
