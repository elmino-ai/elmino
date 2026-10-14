import type { Promisable } from '@elmino/shared'
import type { Part } from '../message/index.js'
import type { Usage } from '../usage/index.js'

/** -------------------- 类型 -------------------- */
/** 可见文本或推理增量；Adapter 不得为 context-only reasoning 发布增量 */
export type PartDelta
  = | { type: 'reasoning', text: string }
    | { type: 'text', text: string }
    | { type: 'tool-args', text: string }

/** Provider 统一流事件；仅用于即时投影，工具 start 只带稳定身份，参数由 tool-args 递增 */
export type Event
  = | { type: 'part-start', index: number, part: Part }
    | { type: 'part-delta', index: number, delta: PartDelta }
    | { type: 'part-end', index: number, part: Part }
    | { type: 'usage', usage: Usage }

/** 非权威流事件处理器 */
export type EventHandler = (event: Event) => Promisable<void>
