import type { RuntimeEvent } from './event.js'
import { isPlainRecord } from '@elmino/shared'
import { ThreadPartSchema } from './part-schema.js'

/** -------------------- 类型 -------------------- */
/** 新增 assistant 文本 */
export interface RuntimeTextPartDelta {
  /** 新增文本 */
  text: string
}

/** 按字符偏移追加的工具输出 */
export interface RuntimeToolOutputPartDelta {
  /** 新增输出 */
  output: string
  /** 在完整输出中的字符偏移 */
  offset: number
}

/** 消息片段增量 */
export type RuntimeMessagePartDelta = RuntimeTextPartDelta | RuntimeToolOutputPartDelta

/** 消息片段增量事件载荷 */
export interface RuntimeMessagePartDeltaPayload {
  /** 新增片段内容 */
  delta: RuntimeMessagePartDelta
}

/** -------------------- 核心函数 -------------------- */
/**
 * 从事件读取完整片段并核对 Thread、Turn、Message 与工具归属
 */
export function readRuntimeEventPartPayload(event: RuntimeEvent) {
  if (event.type !== 'message.part.updated' || !isPlainRecord(event.payload))
    return
  const result = ThreadPartSchema.safeParse(event.payload.part)

  if (!result.success)
    return
  const part = result.data

  if (
    !event.turnId || !event.messageId || !event.partId
    || part.threadId !== event.threadId || part.turnId !== event.turnId
    || part.messageId !== event.messageId || part.id !== event.partId
    || (event.toolCallId !== undefined && (part.type !== 'tool' || part.toolCallId !== event.toolCallId))
  ) {
    return
  }

  return part
}

/**
 * 读取文本增量或带工具归属与非负字符偏移的输出增量
 */
export function readRuntimeEventPartDeltaPayload(event: RuntimeEvent): RuntimeMessagePartDeltaPayload | undefined {
  if (
    event.type !== 'message.part.delta' || !event.turnId || !event.messageId || !event.partId
    || !isPlainRecord(event.payload) || !isPlainRecord(event.payload.delta)
  ) {
    return
  }
  const delta = event.payload.delta

  if (typeof delta.text === 'string' && delta.output === undefined)
    return { delta: { text: delta.text } }
  if (
    event.toolCallId && typeof delta.output === 'string' && typeof delta.offset === 'number'
    && Number.isSafeInteger(delta.offset) && delta.offset >= 0
  ) {
    return { delta: { output: delta.output, offset: delta.offset } }
  }

  return undefined
}

/**
 * 幂等合并按字符偏移定位的工具输出，缺口和冲突拒绝覆盖
 */
export function applyRuntimeToolOutputDelta(current: string, delta: RuntimeToolOutputPartDelta) {
  const { offset, output } = delta

  if (current.length < offset)
    return
  if (current.slice(offset, offset + output.length) === output)
    return current
  if (current.length !== offset)
    return

  return `${current}${output}`
}
