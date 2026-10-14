/** -------------------- 核心函数 -------------------- */
/**
 * 返回保留对象键类型的可枚举属性名
 */
export function objectKeys<T extends object>(obj: T) {
  return Object.keys(obj) as Array<keyof T & string>
}
