import type { ThreadInputContent } from '@elmino/thread'
import { INTERRUPT_ID_PATTERN, MESSAGE_ID_PATTERN, TURN_ID_PATTERN } from '@elmino/protocol'
import { z } from 'zod'
import { HostIdSchema, JsonValueSchema, ThreadTargetSchema } from '../contract/schema'

/** 原始附件使用不带 Data URL 前缀的 Base64，实际解析与压缩由宿主执行 */
const base64 = z.base64().min(1)

/** 复用领域输入联合，文档支持格式由宿主决定 */
export const ThreadInputContentSchema: z.ZodType<
  ThreadInputContent,
  ThreadInputContent
> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1) }),
  z.strictObject({
    type: z.literal('mention'),
    pluginId: HostIdSchema,
    resourceId: HostIdSchema,
    trigger: z.string().regex(/^\S$/u),
    label: z.string().min(1).refine(value => value.trim().length > 0),
    data: JsonValueSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('image'),
    name: z.string().min(1).max(255),
    mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: base64,
    compress: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('document'),
    name: z.string().min(1).max(255),
    extension: z.string().min(1),
    data: base64,
  }),
])

/** 调用者提供固定 Turn ID，宿主解析模型与位置，不从请求接收可执行资源 */
export const ApiTurnCreateInputSchema = ThreadTargetSchema.extend({
  turnId: z.string().regex(TURN_ID_PATTERN),
  input: z.array(ThreadInputContentSchema).min(1),
  modelId: HostIdSchema.optional(),
  approvalMode: z.enum(['request', 'auto', 'fullAccess']).optional(),
  subagentMode: z.enum(['explicitOnly', 'proactive']).optional(),
})

/** 控制请求必须明确命中当前运行，禁止省略 Turn ID */
export const ApiTurnTargetSchema = ThreadTargetSchema.extend({ turnId: z.string().regex(TURN_ID_PATTERN) })

/** 恢复只提交原中断与 JSON 回复，不允许覆盖冻结模型和权限 */
export const ApiTurnResumeInputSchema = ApiTurnTargetSchema.extend({
  interruptId: z.string().regex(INTERRUPT_ID_PATTERN),
  response: JsonValueSchema,
})
export const ApiTurnInterruptInputSchema = ApiTurnTargetSchema.extend({ reason: z.string().optional() })
export const ApiTurnSteerInputSchema = ApiTurnTargetSchema.extend({
  text: z.string().min(1).refine(value => value.trim().length > 0),
})
export const ApiTurnSteerResultSchema = z.object({
  turnId: z.string().regex(TURN_ID_PATTERN),
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
})

export type ApiTurnCreateInput = z.infer<typeof ApiTurnCreateInputSchema>
export type ApiTurnResumeInput = z.infer<typeof ApiTurnResumeInputSchema>
export type ApiTurnInterruptInput = z.infer<typeof ApiTurnInterruptInputSchema>
export type ApiTurnSteerInput = z.infer<typeof ApiTurnSteerInputSchema>
export type ApiTurnSteerResult = z.infer<typeof ApiTurnSteerResultSchema>
