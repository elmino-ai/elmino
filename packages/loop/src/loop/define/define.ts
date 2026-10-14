import type { Loop } from '../types/index'
import { executeTurn } from '../turn/execute'

/** -------------------- 核心函数 -------------------- */
/**
 * 定义一条完整的 Loop
 */
export function defineLoop(): Loop {
  return {
    invoke: executeTurn,
  }
}
