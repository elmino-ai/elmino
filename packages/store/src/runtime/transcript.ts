import type { ThreadMessage } from '../thread/message.js'

/** -------------------- 类型 -------------------- */
/** 持久化 transcript 消息投影仓储 */
export interface RuntimeTranscriptRepository {
  /** 创建或更新完整消息投影 */
  upsert: (message: ThreadMessage) => Promise<ThreadMessage>
  /** 按消息 ID 读取完整投影 */
  read: (id: string) => Promise<ThreadMessage | undefined>
  /** 按线程顺序列出全部或指定 Turn 的投影 */
  list: (threadId: string, turnIds?: string[]) => Promise<ThreadMessage[]>
}
