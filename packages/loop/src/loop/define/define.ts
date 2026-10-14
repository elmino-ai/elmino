import type { Loop } from '../types/index.js'
import { executeTurn } from '../turn/execute.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 定义一条完整的 Loop
 */
export function defineLoop(): Loop {
  return {
    invoke: executeTurn,
  }
}
