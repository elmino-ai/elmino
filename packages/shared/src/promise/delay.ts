/** -------------------- 核心函数 -------------------- */
/**
 * 等待指定毫秒数
 */
export function delay(waitMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, waitMs))
  })
}
