import type { JsonValue } from '@elmino/shared'
import type { ThreadPart } from '@elmino/store'
import { isJsonValue } from '@elmino/shared'
import { z } from 'zod'

/** -------------------- 常量 -------------------- */
/** 完整消息片段的持久归属与时序字段 */
const base = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  status: z.enum(['completed', 'failed', 'pending', 'running', 'skipped']),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

/** 事件回调读取完整消息片段时使用的领域边界，不含 HTTP 或 SDK 状态 */
export const ThreadPartSchema: z.ZodType<ThreadPart> = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('text'), text: z.string() }),
  base.extend({ type: z.literal('error'), text: z.string() }),
  base.extend({
    type: z.literal('reasoning'),
    text: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  base.extend({
    type: z.literal('mention'),
    pluginId: z.string().min(1),
    resourceId: z.string().min(1),
    trigger: z.string().regex(/^\S$/u),
    label: z.string().refine(value => value.trim().length > 0),
    data: z.custom<JsonValue>(isJsonValue).optional(),
  }),
  base.extend({
    type: z.literal('image'),
    name: z.string(),
    mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    url: z.url(),
  }),
  base.extend({ type: z.literal('document'), name: z.string(), extension: z.string(), artifactId: z.string().optional() }),
  base.extend({
    type: z.literal('tool'),
    toolName: z.string(),
    toolCallId: z.string().optional(),
    providerCallId: z.string().optional(),
    args: z.unknown().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    decision: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    hidden: z.boolean().optional(),
  }),
  base.extend({ type: z.literal('plugin'), pluginId: z.string().min(1), name: z.string().min(1), data: z.custom<JsonValue>(isJsonValue) }),
  base.extend({ type: z.literal('event'), title: z.string(), detail: z.string().optional(), payload: z.unknown().optional() }),
])
