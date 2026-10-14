/** -------------------- 核心函数 -------------------- */
/**
 * 创建带领域前缀的 UUID v4 ID
 */
export function createId<const TPrefix extends string>(prefix: TPrefix) {
  return `${prefix}_${crypto.randomUUID()}` as `${TPrefix}_${string}`
}
