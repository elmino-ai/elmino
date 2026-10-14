import type { SubagentController } from '../types/types.js'
import { defineHostService } from './services.js'

/** -------------------- 服务标识 -------------------- */
/** 当前根 Turn 子智能体控制服务 */
export const subagentHostService
  = defineHostService<SubagentController>('subagent')
