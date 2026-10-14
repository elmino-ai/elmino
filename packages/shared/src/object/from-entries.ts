/** -------------------- 核心函数 -------------------- */
/**
 * 从键值条目创建保留键值类型的对象
 */
export function objectFromEntries<K extends PropertyKey, V>(
  entries: Iterable<readonly [K, V]>,
) {
  return Object.fromEntries(entries) as Record<K, V>
}
