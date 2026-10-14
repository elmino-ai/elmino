import { createId, objectPick } from '@elmino/shared'

/** -------------------- 常量 -------------------- */
/** 执行事实事件名称，不定义宿主传输协议 */
export const RUNTIME_EVENT_TYPES = [
  'thread.created',
  'thread.updated',
  'thread.deleted',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.cancelled',
  'thread.child.updated',
  'context.budget',
  'token.usage',
] as const

/** 当前执行片段的终态观察事件，中断仍可通过恢复入口继续 */
export const TERMINAL_TURN_EVENT_TYPES = [
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.cancelled',
] as const

/** -------------------- 类型 -------------------- */
/** 执行事实事件名称 */
export type RuntimeEventType = typeof RUNTIME_EVENT_TYPES[number]

/** 一次执行事实变化的结构化事件 */
export interface RuntimeEvent<TPayload = unknown> {
  /** 事件唯一 ID */
  id: string
  /** 事件类型 */
  type: RuntimeEventType
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId?: string
  /** 所属消息 ID */
  messageId?: string
  /** 所属消息片段 ID */
  partId?: string
  /** 所属工具调用 ID */
  toolCallId?: string
  /** 所属中断 ID */
  interruptId?: string
  /** 创建时间 */
  createdAt: string
  /** 事件载荷 */
  payload: TPayload
}

/** 创建执行事件所需数据，事件 ID 统一由工厂生成 */
export interface CreateRuntimeEventInput<TPayload = unknown>
  extends Pick<RuntimeEvent<TPayload>, 'payload' | 'threadId' | 'type'>,
  Partial<Pick<
    RuntimeEvent<TPayload>,
    | 'createdAt'
    | 'interruptId'
    | 'messageId'
    | 'partId'
    | 'turnId'
    | 'toolCallId'
  >> {}

/** -------------------- 核心函数 -------------------- */
/**
 * 从调用方明确提供的归属创建结构化执行事件
 */
export function createRuntimeEvent<TPayload = unknown>(
  input: CreateRuntimeEventInput<TPayload>,
): RuntimeEvent<TPayload> {
  return {
    id: createId('event'),
    ...objectPick(input, 'type', 'threadId', 'turnId', 'messageId', 'partId', 'toolCallId', 'interruptId', 'payload'),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}
