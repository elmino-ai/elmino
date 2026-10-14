import type { JsonValue } from '@elmino/shared'
import { isJsonValue, isOneOf, isPlainRecord } from '@elmino/shared'
import { INTERRUPT_ID_PATTERN, TURN_ID_PATTERN } from './id.js'

/** -------------------- 类型 -------------------- */
/** 线程中断类型 */
export type ThreadInterruptKind = 'interaction' | 'system' | 'user'

/** 线程中断状态 */
export type ThreadInterruptStatus = 'pending' | 'resolved' | 'cancelled'

/** 线程中断恢复动作 */
export type ThreadInterruptResumeAction = 'interaction' | 'message'

/** 当前运行中断信息 */
export interface ThreadInterrupt<
  TPayload extends JsonValue = JsonValue,
> {
  /** 中断唯一 ID */
  id: string
  /** 中断类型 */
  kind: ThreadInterruptKind
  /** Interaction 在所属命名空间内的稳定名称 */
  interaction?: string
  /** 插件 Interaction 的稳定插件 ID；Loop 内置 Interaction 不提供 */
  pluginId?: string
  /** 中断状态 */
  status: ThreadInterruptStatus
  /** 所属 Turn ID */
  turnId: string
  /** 中断原因 */
  reason: string
  /** 中断携带的恢复上下文 */
  payload?: TPayload
  /** 中断创建时间 */
  createdAt: string
  /** 中断恢复时间 */
  resolvedAt?: string
  /** 等待前端补充的动作 */
  resumableWith: ThreadInterruptResumeAction[]
}

/** 可由外部 response 恢复的 Interaction 中断 */
export interface ThreadInteractionInterrupt<
  TPayload extends JsonValue = JsonValue,
> extends ThreadInterrupt<TPayload> {
  /** Interaction 使用统一中断类型 */
  kind: 'interaction'
  /** Interaction 在所属命名空间内的稳定名称 */
  interaction: string
  /** Interaction 恢复时使用的持久化 JSON 载荷 */
  payload: TPayload
  /** Interaction 只接受统一 response 恢复 */
  resumableWith: ['interaction']
}

/** -------------------- 常量 -------------------- */
/** 中断类型 */
const INTERRUPT_KINDS = [
  'interaction',
  'user',
  'system',
] as const
/** 中断状态 */
const INTERRUPT_STATUSES = ['pending', 'resolved', 'cancelled'] as const
/** 中断恢复动作 */
const INTERRUPT_RESUME_ACTIONS = [
  'interaction',
  'message',
] as const

/** -------------------- 核心函数 -------------------- */
/**
 * 从外部事件载荷读取完整线程中断事实
 */
export function readThreadInterrupt(
  value: unknown,
): ThreadInterrupt | undefined {
  return isThreadInterrupt(value) ? value : undefined
}

/**
 * 从未知中断读取可恢复的 Interaction 事实
 */
export function readThreadInteraction(
  interrupt: ThreadInterrupt | undefined,
): ThreadInteractionInterrupt | undefined {
  if (
    interrupt?.kind !== 'interaction'
    || typeof interrupt.interaction !== 'string'
    || !interrupt.interaction
    || interrupt.payload === undefined
    || interrupt.resumableWith.length !== 1
    || interrupt.resumableWith[0] !== 'interaction'
  ) {
    return
  }

  return interrupt as ThreadInteractionInterrupt
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断未知值是否为完整线程中断事实
 */
function isThreadInterrupt(
  value: unknown,
): value is ThreadInterrupt {
  if (!isPlainRecord(value))
    return false

  return (
    typeof value.id === 'string'
    && INTERRUPT_ID_PATTERN.test(value.id)
    && isOneOf(value.kind, INTERRUPT_KINDS)
    && isOneOf(value.status, INTERRUPT_STATUSES)
    && typeof value.turnId === 'string'
    && TURN_ID_PATTERN.test(value.turnId)
    && typeof value.reason === 'string'
    && typeof value.createdAt === 'string'
    && (
      value.payload === undefined
      || isJsonValue(value.payload)
    )
    && (
      value.interaction === undefined
      || typeof value.interaction === 'string'
    )
    && (
      value.pluginId === undefined
      || (
        typeof value.pluginId === 'string'
        && value.pluginId.length > 0
      )
    )
    && (
      value.kind !== 'interaction'
      || (
        typeof value.interaction === 'string'
        && value.interaction.length > 0
      )
    )
    && (
      value.resolvedAt === undefined
      || typeof value.resolvedAt === 'string'
    )
    && Array.isArray(value.resumableWith)
    && value.resumableWith.every(item => (
      isOneOf(item, INTERRUPT_RESUME_ACTIONS)
    ))
  )
}
