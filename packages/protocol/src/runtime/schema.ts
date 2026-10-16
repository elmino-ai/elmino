import type { RuntimeEvent } from '@elmino/thread/events'
import { RUNTIME_EVENT_TYPES } from '@elmino/thread/events'
import { z } from 'zod'
import { JsonValueSchema } from '../json/schema'
import {
  EventIdSchema,
  InterruptIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
  ThreadPartIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './id'
import { hasValidRuntimeEventPayload } from './payload'

/** -------------------- Schema -------------------- */
/** 统一的跨端事件边界，不在内核内部重复执行输入校验 */
export const RuntimeEventSchema: z.ZodType<RuntimeEvent> = z.object({
  id: EventIdSchema,
  type: z.enum(RUNTIME_EVENT_TYPES),
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema.optional(),
  messageId: MessageIdSchema.optional(),
  partId: ThreadPartIdSchema.optional(),
  toolCallId: ToolCallIdSchema.optional(),
  interruptId: InterruptIdSchema.optional(),
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
