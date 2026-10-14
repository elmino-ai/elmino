import type { SubagentController } from '../types/types'
import { defineHostService } from './services'

/** -------------------- 服务标识 -------------------- */
/** 当前根 Turn 子智能体控制服务 */
export const subagentHostService
  = defineHostService<SubagentController>('subagent')
