import { createHash } from 'node:crypto'

/** -------------------- 核心函数 -------------------- */
/**
 * 计算内容 sha256
 */
export function sha256(content: string | Uint8Array) {
  return createHash('sha256').update(content).digest('hex')
}
