import type { JsonValue } from '@elmino/shared'
import type { ThreadMessage, ThreadPart, ThreadSettings, ThreadTokenUsage } from '@elmino/store'
import type {
  ThreadChildState,
  ThreadContextBudget,
  ThreadInterrupt,
  ThreadListItem,
  ThreadRuntimeState,
  ThreadState,
  ThreadUsagePayload,
} from '@elmino/thread'
import { isJsonValue } from '@elmino/shared'
import { readThreadInterrupt, ThreadPartSchema } from '@elmino/thread/events'
import { z } from 'zod'
import {
  MESSAGE_ID_PATTERN,
  THREAD_ID_PATTERN,
  THREAD_PART_ID_PATTERN,
  TOOL_CALL_ID_PATTERN,
  TURN_ID_PATTERN,
} from '../runtime/id'

/** JSON 化后的扩展数据，不接受函数、循环引用或非有限数字 */
const jsonValue = z.custom<JsonValue>(isJsonValue)
const jsonRecord = z.record(z.string(), jsonValue)
const identifier = z.string().min(1)
const datetime = z.iso.datetime({ offset: true })
const turnStatus = z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'])
const threadStatus = z.enum(['idle', 'running', 'interrupted', 'completed', 'failed'])

/** 传输只校验已有用量，不根据收到的数据重算或归一化运行事实 */
const tokenUsage: z.ZodType<ThreadTokenUsage> = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  estimated: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1),
})

/** 当前线程与派生任务的累计用量 */
export const ThreadUsagePayloadSchema: z.ZodType<ThreadUsagePayload> = z.object({
  usage: tokenUsage,
  taskUsage: tokenUsage,
})

/** 上下文可能已经超预算，剩余额度允许为零 */
export const ThreadContextBudgetSchema: z.ZodType<ThreadContextBudget> = z.object({
  usedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().nonnegative(),
  remainingTokens: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  estimation: z.enum(['approximate', 'provider']),
  updatedAt: datetime,
})

/** 复用领域中断判定，并在传输边界补齐 JSON、时间与交互恢复约束 */
export const ThreadInterruptSchema: z.ZodType<ThreadInterrupt> = z.custom<ThreadInterrupt>((value) => {
  const interrupt = readThreadInterrupt(value)
  return Boolean(interrupt
    && Object.values(interrupt).every(item => item === undefined || isJsonValue(item))
    && datetime.safeParse(interrupt.createdAt).success
    && (interrupt.resolvedAt === undefined || datetime.safeParse(interrupt.resolvedAt).success)
    && (interrupt.kind !== 'interaction' || (
      interrupt.payload !== undefined
      && interrupt.resumableWith.length === 1
      && interrupt.resumableWith[0] === 'interaction'
    )))
})

/** 领域可选字段允许 undefined；其余字段值必须能无损传输为 JSON */
export const ThreadPartWireSchema: z.ZodType<ThreadPart> = ThreadPartSchema.superRefine((part, context) => {
  for (const [key, value] of Object.entries(part)) {
    if (value !== undefined && !isJsonValue(value))
      context.addIssue({ code: 'custom', path: [key], message: '消息片段字段必须是 JSON 值' })
  }
  if (!THREAD_PART_ID_PATTERN.test(part.id)
    || (part.id.startsWith('msg_') && !part.id.startsWith(`${part.messageId}:`))) {
    context.addIssue({ code: 'custom', path: ['id'], message: '消息片段标识无效或不属于当前消息' })
  }
  if (!MESSAGE_ID_PATTERN.test(part.messageId))
    context.addIssue({ code: 'custom', path: ['messageId'], message: '消息标识无效' })
  if (!THREAD_ID_PATTERN.test(part.threadId))
    context.addIssue({ code: 'custom', path: ['threadId'], message: '线程标识无效' })
  if (!TURN_ID_PATTERN.test(part.turnId))
    context.addIssue({ code: 'custom', path: ['turnId'], message: '运行标识无效' })
  if (part.type === 'tool' && part.toolCallId !== undefined && !TOOL_CALL_ID_PATTERN.test(part.toolCallId))
    context.addIssue({ code: 'custom', path: ['toolCallId'], message: '工具调用标识无效' })
})

/** 完整消息与其片段必须属于同一 Thread、Turn 和 Message */
export const ThreadMessageSchema: z.ZodType<ThreadMessage> = z.object({
  id: z.string().regex(MESSAGE_ID_PATTERN),
  threadId: z.string().regex(THREAD_ID_PATTERN),
  turnId: z.string().regex(TURN_ID_PATTERN),
  role: z.enum(['assistant', 'system', 'user']),
  kind: z.enum(['error', 'normal', 'synthetic']),
  status: z.enum(['completed', 'created', 'failed', 'interrupted', 'streaming']),
  parts: z.array(ThreadPartWireSchema),
  createdAt: datetime,
  updatedAt: datetime,
  metadata: jsonRecord,
}).superRefine((message, context) => {
  for (const [index, part] of message.parts.entries()) {
    if (part.messageId !== message.id || part.threadId !== message.threadId || part.turnId !== message.turnId) {
      context.addIssue({ code: 'custom', path: ['parts', index], message: '消息片段不属于当前消息、线程或运行' })
    }
  }
})

/** 子线程描述保留其自有 Turn；事件外壳的 Turn 属于父线程，不能混用 */
export const ThreadChildStateSchema: z.ZodType<ThreadChildState> = z.object({
  ownerId: identifier,
  threadId: z.string().regex(THREAD_ID_PATTERN),
  turnId: z.string().regex(TURN_ID_PATTERN),
  parentToolCallId: z.string().regex(TOOL_CALL_ID_PATTERN),
  title: z.string().optional(),
  status: turnStatus,
  interrupt: ThreadInterruptSchema.optional(),
  data: jsonRecord,
  createdAt: datetime,
  startedAt: datetime.optional(),
  endedAt: datetime.optional(),
  updatedAt: datetime,
}).superRefine((child, context) => {
  if (child.interrupt && child.interrupt.turnId !== child.turnId)
    context.addIssue({ code: 'custom', path: ['interrupt', 'turnId'], message: '中断不属于子线程当前运行' })
})

/** 模型与工作区配置键由宿主定义，不绑定旧产品 ID 或文件扩展名列表 */
const settings: z.ZodType<ThreadSettings> = z.object({
  modelId: identifier.optional(),
  reasoningLevel: z.string().optional(),
  approvalMode: z.enum(['request', 'auto', 'fullAccess']),
  subagentMode: z.enum(['explicitOnly', 'proactive']),
  pluginSettings: z.record(z.string().refine(key => key.trim().length > 0), jsonRecord),
})

const runtime: z.ZodType<ThreadRuntimeState> = z.object({
  status: threadStatus,
  turnId: z.string().regex(TURN_ID_PATTERN).optional(),
  modelId: identifier.optional(),
  agentId: identifier,
  approvalMode: z.enum(['request', 'auto', 'fullAccess']),
  usage: tokenUsage,
  taskUsage: tokenUsage,
  contextBudget: ThreadContextBudgetSchema.optional(),
  interrupt: ThreadInterruptSchema.optional(),
}).superRefine((value, context) => {
  if (value.interrupt && value.interrupt.turnId !== value.turnId)
    context.addIssue({ code: 'custom', path: ['interrupt', 'turnId'], message: '中断不属于当前运行' })
})

/** 完整线程与轻量列表复用的公开字段 */
const threadState = z.object({
  workspaceId: identifier,
  workspaceRoot: z.string(),
  cwd: z.string(),
  threadId: z.string().regex(THREAD_ID_PATTERN),
  title: z.string().optional(),
  agentId: identifier,
  pinned: z.boolean(),
  unreadAt: datetime.nullable(),
  archivedAt: datetime.nullable(),
  createdAt: datetime,
  lastInteractionAt: datetime,
  updatedAt: datetime,
  messages: z.array(ThreadMessageSchema),
  turns: z.array(z.object({
    id: z.string().regex(TURN_ID_PATTERN),
    status: turnStatus,
    agentId: identifier,
    startedAt: datetime.optional(),
    endedAt: datetime.optional(),
  })),
  children: z.array(ThreadChildStateSchema),
  extensions: z.record(identifier, jsonRecord),
  settings,
  runtime,
})

/** 完整线程 wire 投影，扩展状态和标题使用当前领域契约 */
export const ThreadStateSchema: z.ZodType<ThreadState> = threadState.superRefine((thread, context) => {
  const turns = new Set(thread.turns.map(turn => turn.id))
  for (const [index, message] of thread.messages.entries()) {
    if (message.threadId !== thread.threadId || !turns.has(message.turnId))
      context.addIssue({ code: 'custom', path: ['messages', index], message: '消息不属于当前线程或运行时间线' })
  }
  if (thread.runtime.agentId !== thread.agentId)
    context.addIssue({ code: 'custom', path: ['runtime', 'agentId'], message: '运行环境不属于当前智能体' })
  for (const [index, turn] of thread.turns.entries()) {
    if (turn.agentId !== thread.agentId)
      context.addIssue({ code: 'custom', path: ['turns', index, 'agentId'], message: '运行不属于当前智能体' })
  }
})

/** 列表只包含稳定元信息与运行摘要，不重复传输消息和全部历史 */
export const ThreadListItemSchema: z.ZodType<ThreadListItem> = threadState.pick({
  threadId: true,
  title: true,
  workspaceId: true,
  agentId: true,
  pinned: true,
  unreadAt: true,
  archivedAt: true,
  lastInteractionAt: true,
  updatedAt: true,
  settings: true,
}).extend({
  runtime: z.object({ status: threadStatus, interrupt: ThreadInterruptSchema.optional() }),
})
