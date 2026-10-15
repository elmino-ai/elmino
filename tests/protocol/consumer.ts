import type { RuntimeStreamMessage } from '@elmino/protocol'
import {
  createRuntimeEventCursor,
  isRuntimeEvent,
  isRuntimeStreamMessage,
  parseRuntimeEventCursor,
  parseRuntimeEventJson,
  RuntimeStreamMessageSchema,
  serializeRuntimeEvent,
} from '@elmino/protocol'
import { createId } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread/events'

const event = createRuntimeEvent({
  type: 'turn.completed',
  threadId: createId('thread'),
  turnId: createId('turn'),
  payload: { unreadAt: new Date().toISOString() },
})
const message: RuntimeStreamMessage | undefined = parseRuntimeEventJson(serializeRuntimeEvent(event))
if (!isRuntimeEvent(message) || message.id !== event.id)
  throw new Error('运行事件无法跨 JSON 边界恢复')
if (!RuntimeStreamMessageSchema.safeParse(message).success || !isRuntimeStreamMessage({ type: 'stream.reset' }))
  throw new Error('事件流校验不可用')
if (isRuntimeStreamMessage({ ...event, type: 'message.updated', payload: {} }))
  throw new Error('事件流放过了无效消息载荷')
const cursor = { streamId: createId('stream'), sequence: 42 }
if (parseRuntimeEventCursor(createRuntimeEventCursor(cursor))?.sequence !== 42)
  throw new Error('恢复游标无法往返')
