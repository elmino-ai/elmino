import type { ThreadMessage } from '@elmino/store'
import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import { isPlainRecord } from '@elmino/shared'
import {
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
  readThreadInterrupt,
} from '@elmino/thread/events'
import { z } from 'zod'
import {
  ThreadChildStateSchema,
  ThreadContextBudgetSchema,
  ThreadInterruptSchema,
  ThreadMessageSchema,
  ThreadPartWireSchema,
  ThreadStateSchema,
  ThreadUsagePayloadSchema,
} from '../thread/schema'

/** -------------------- 常量 -------------------- */
/** 根 Turn 终态事件中的权威未读时间 */
const unreadAtSchema = z.iso.datetime({ offset: true })

/** -------------------- 核心函数 -------------------- */
/**
 * 读取完整消息并核对事件与所有消息片段的归属
 */
export function readRuntimeEventMessagePayload(event: RuntimeEvent): ThreadMessage | undefined {
  if (event.type !== 'message.updated' || !isPlainRecord(event.payload))
    return
  const result = ThreadMessageSchema.safeParse(event.payload.message)
  if (!result.success || !event.turnId || !event.messageId)
    return
  const message = result.data
  if (
    message.threadId !== event.threadId || message.turnId !== event.turnId || message.id !== event.messageId
    || (event.partId !== undefined && !message.parts.some(part => part.id === event.partId))
    || (event.toolCallId !== undefined && !message.parts.some(part => (
      part.type === 'tool' && part.toolCallId === event.toolCallId
      && (event.partId === undefined || part.id === event.partId)
    )))
  ) {
    return
  }

  return message
}

/**
 * 读取线程快照，事件只能更新自身线程及当前 Turn
 */
export function readRuntimeEventThreadStatePayload(event: RuntimeEvent): ThreadState | undefined {
  if (event.type !== 'thread.created' && event.type !== 'thread.updated')
    return
  const result = ThreadStateSchema.safeParse(event.payload)
  if (!result.success)
    return
  const thread = result.data
  if (
    thread.threadId !== event.threadId
    || (event.turnId !== undefined && thread.runtime.turnId !== undefined && event.turnId !== thread.runtime.turnId)
  ) {
    return
  }

  return thread
}

/**
 * 读取线程删除事件中的宿主工作区键，不依赖旧产品工作区常量
 */
export function readRuntimeEventThreadDeletedWorkspaceId(event: RuntimeEvent): string | undefined {
  if (event.type !== 'thread.deleted' || !isPlainRecord(event.payload))
    return
  const workspaceId = event.payload.workspaceId
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : undefined
}

/**
 * 读取终态事件中的未读时间，系统中断与用户取消不产生待响应提醒
 */
export function readRuntimeEventTurnUnreadAt(event: RuntimeEvent): string | undefined {
  if (!['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type) || !isPlainRecord(event.payload))
    return
  if (event.type === 'turn.interrupted' && readThreadInterrupt(event.payload)?.kind !== 'interaction')
    return
  const result = unreadAtSchema.safeParse(event.payload.unreadAt)
  return result.success ? result.data : undefined
}

/**
 * 检查各事件必须携带的完整载荷，在 API 与 SDK 共用同一判定
 */
export function hasValidRuntimeEventPayload(event: RuntimeEvent): boolean {
  if (event.type === 'message.updated')
    return Boolean(readRuntimeEventMessagePayload(event))
  if (event.type === 'message.part.updated') {
    return isPlainRecord(event.payload) && ThreadPartWireSchema.safeParse(event.payload.part).success
      && Boolean(readRuntimeEventPartPayload(event))
  }
  if (event.type === 'message.part.delta')
    return Boolean(readRuntimeEventPartDeltaPayload(event))
  if (event.type === 'message.part.removed')
    return Boolean(event.turnId && event.messageId && event.partId)
  if (event.type === 'thread.created' || event.type === 'thread.updated')
    return Boolean(readRuntimeEventThreadStatePayload(event))
  if (event.type === 'thread.deleted')
    return Boolean(readRuntimeEventThreadDeletedWorkspaceId(event))
  if (event.type === 'thread.child.updated')
    return ThreadChildStateSchema.safeParse(event.payload).success
  if (event.type === 'token.usage')
    return ThreadUsagePayloadSchema.safeParse(event.payload).success
  if (event.type === 'context.budget')
    return ThreadContextBudgetSchema.safeParse(event.payload).success
  if (!event.turnId || !isPlainRecord(event.payload))
    return false
  const unreadAt = event.payload.unreadAt
  if (unreadAt !== undefined && !readRuntimeEventTurnUnreadAt(event))
    return false
  if (event.type === 'turn.interrupted') {
    const result = ThreadInterruptSchema.safeParse(event.payload)
    const interrupt = result.success ? result.data : undefined
    return Boolean(
      interrupt && event.interruptId === interrupt.id && event.turnId === interrupt.turnId,
    )
  }

  return true
}
