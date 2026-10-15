import type { RuntimeEvent } from '@elmino/thread/events'

/** -------------------- 类型 -------------------- */
/** 事件流连接或回放失效通知；游标由 SSE id 承载 */
export interface RuntimeStreamControl {
  /** connected 表示连接建立，reset 要求重新读取持久化快照 */
  type: 'stream.connected' | 'stream.reset'
}

/** 跨端运行事件与流控制消息，不重新定义领域 RuntimeEvent */
export type RuntimeStreamMessage = RuntimeEvent | RuntimeStreamControl
