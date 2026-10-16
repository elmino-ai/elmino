import type { ThreadInputContent } from '@elmino/thread'
import { InterruptIdSchema, MessageIdSchema, TurnIdSchema } from '@elmino/protocol'
import { NonBlankStringSchema } from '@elmino/schema'
import { z } from 'zod'
import { HostIdSchema, JsonValueSchema, ThreadTargetSchema } from '../contract/schema'

/** 原始附件使用不带 Data URL 前缀的 Base64，实际解析与压缩由宿主执行 */
const base64 = z.base64().min(1).describe('不带 Data URL 前缀的 Base64 文件内容').meta({ examples: ['SGVsbG8='] })

/** 复用领域输入联合，文档支持格式由宿主决定 */
export const ThreadInputContentSchema: z.ZodType<
  ThreadInputContent,
  ThreadInputContent
> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string().min(1).describe('发送给 Agent 的原始文本，不自动裁剪空白').meta({ examples: ['请帮我写一份笔记'] }),
  }),
  z.strictObject({
    type: z.literal('mention'),
    pluginId: HostIdSchema.describe('宿主注册的资源提供方键').meta({ examples: ['skills'] }),
    resourceId: HostIdSchema.describe('提供方作用域内的资源标识').meta({ examples: ['review'] }),
    trigger: z.string().regex(/^\S$/u).describe('资源引用的单个非空白触发字符').meta({ examples: ['@'] }),
    label: NonBlankStringSchema.describe('引用资源的显示名称'),
    data: JsonValueSchema.describe('由宿主资源提供方解释的 JSON 附加数据').optional(),
  }),
  z.strictObject({
    type: z.literal('image'),
    name: z.string().min(1).max(255).describe('用于显示与附件处理的原始文件名'),
    mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']).describe('图片实际内容的 MIME 类型'),
    data: base64,
    compress: z.boolean().describe('是否允许宿主压缩图片；实际策略由宿主决定'),
  }),
  z.strictObject({
    type: z.literal('document'),
    name: z.string().min(1).max(255).describe('用于显示与附件处理的原始文件名'),
    extension: z.string().min(1).describe('宿主文档解析器识别的格式键，具体支持范围由宿主决定').meta({ examples: ['pdf'] }),
    data: base64,
  }),
])

/** 调用者提供固定 Turn ID，宿主解析模型与位置，不从请求接收可执行资源 */
export const ApiTurnCreateInputSchema = ThreadTargetSchema.extend({
  turnId: TurnIdSchema.describe('客户端为本次运行生成的唯一标识，控制操作必须携带原值'),
  input: z.array(ThreadInputContentSchema).min(1).describe('至少一项文本、引用、图片或文档输入').meta({ examples: [[{ type: 'text', text: '你好，请介绍你能做什么' }]] }),
  modelId: HostIdSchema.describe('宿主模型注册表中的稳定键；省略时使用线程或 Agent 的默认模型').meta({ examples: ['deepseek'] }).optional(),
  approvalMode: z.enum(['request', 'auto', 'fullAccess']).describe('工具审批模式：request 按策略请求审批，auto 使用自动审批策略，fullAccess 授予完整访问；省略时沿用应用配置').optional(),
  subagentMode: z.enum(['explicitOnly', 'proactive']).describe('子智能体模式：explicitOnly 仅显式派生，proactive 允许主动派生；省略时沿用应用配置').optional(),
})

/** 控制请求必须明确命中当前运行，禁止省略 Turn ID */
export const ApiTurnTargetSchema = ThreadTargetSchema.extend({ turnId: TurnIdSchema })

/** 恢复只提交原中断与 JSON 回复，不允许覆盖冻结模型和权限 */
export const ApiTurnResumeInputSchema = ApiTurnTargetSchema.extend({
  interruptId: InterruptIdSchema.describe('当前待处理交互中断的标识，必须与指定运行中的中断一致'),
  response: JsonValueSchema.describe('交互工具约定的 JSON 回复；审批时提交批准或拒绝决定，具体结构由交互类型定义').meta({ examples: [{ decisions: [{ type: 'approve', callId: 'native_tool_call_id' }] }] }),
})
export const ApiTurnInterruptInputSchema = ApiTurnTargetSchema.extend({
  reason: z.string().describe('可选的中断原因，会记录在运行结果中').meta({ examples: ['用户停止任务'] }).optional(),
})
export const ApiTurnSteerInputSchema = ApiTurnTargetSchema.extend({
  text: NonBlankStringSchema.describe('向正在运行的 Agent 追加的引导文本，保留原始空白').meta({ examples: ['请先完成摘要，再继续分析'] }),
})
export const ApiTurnSteerResultSchema = z.object({
  turnId: TurnIdSchema,
  messageId: MessageIdSchema.describe('已接纳引导消息的标识'),
})

export type ApiTurnCreateInput = z.infer<typeof ApiTurnCreateInputSchema>
export type ApiTurnResumeInput = z.infer<typeof ApiTurnResumeInputSchema>
export type ApiTurnInterruptInput = z.infer<typeof ApiTurnInterruptInputSchema>
export type ApiTurnSteerInput = z.infer<typeof ApiTurnSteerInputSchema>
export type ApiTurnSteerResult = z.infer<typeof ApiTurnSteerResultSchema>
