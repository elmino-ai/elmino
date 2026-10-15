import type { RuntimeEvent } from '@elmino/thread/events'
import { RUNTIME_EVENT_TYPES } from '@elmino/thread/events'
import { z } from 'zod'
import { JsonValueSchema } from '../json/schema'
import {
  EVENT_ID_PATTERN,
  INTERRUPT_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  THREAD_ID_PATTERN,
  THREAD_PART_ID_PATTERN,
  TOOL_CALL_ID_PATTERN,
  TURN_ID_PATTERN,
} from './id'
import { hasValidRuntimeEventPayload } from './payload'

/** -------------------- Schema -------------------- */
/** 统一的跨端事件边界，不在内核内部重复执行输入校验 */
export const RuntimeEventSchema: z.ZodType<RuntimeEvent> = z.object({
  id: z.string().regex(EVENT_ID_PATTERN),
  type: z.enum(RUNTIME_EVENT_TYPES),
  threadId: z.string().regex(THREAD_ID_PATTERN),
  turnId: z.string().regex(TURN_ID_PATTERN).optional(),
  messageId: z.string().regex(MESSAGE_ID_PATTERN).optional(),
  partId: z.string().regex(THREAD_PART_ID_PATTERN).optional(),
  toolCallId: z.string().regex(TOOL_CALL_ID_PATTERN).optional(),
  interruptId: z.string().regex(INTERRUPT_ID_PATTERN).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  payload: JsonValueSchema,
}).refine(event => (
  !event.partId?.startsWith('msg_')
  || (event.messageId !== undefined && event.partId.startsWith(`${event.messageId}:`))
)).refine(hasValidRuntimeEventPayload, '事件载荷或归属无效')

/** 连接建立与客户端需要重建快照的控制消息 */
export const RuntimeStreamControlSchema = z.object({
  type: z.enum(['stream.connected', 'stream.reset']),
}).strict()

/** Server 输出与 SDK 输入使用相同的载荷校验 */
export const RuntimeStreamMessageSchema = z.union([RuntimeEventSchema, RuntimeStreamControlSchema])
