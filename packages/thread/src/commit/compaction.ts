import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import type { CompactionInput, TurnRef } from './types'
import { createId } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 持久化不进入 Provider Context 的上下文压缩完成边界
 */
export function persistCompaction(
  store: RuntimeStore,
  turn: TurnRef,
  input: CompactionInput = {},
): Promise<ThreadMessage> {
  const createdAt = new Date().toISOString()
  const messageId = createId('msg')
  const { threadId, turnId } = turn
  const transcript: ThreadMessage = {
    id: messageId,
    threadId,
    turnId,
    role: 'system',
    kind: 'synthetic',
    status: 'completed',
    parts: [{
      id: createId('part'),
      messageId,
      threadId,
      turnId,
      seq: 1,
      type: 'event',
      status: 'completed',
      title: input.title ?? 'context.compacted',
      createdAt,
      updatedAt: createdAt,
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  }

  return store.transcript.upsert(transcript)
}
