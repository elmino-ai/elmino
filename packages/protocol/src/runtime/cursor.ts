import { STREAM_ID_PATTERN } from './id'

/** -------------------- 类型 -------------------- */
/** 游标中的流身份与已处理位置；回放窗口是否仍保留该位置由 Server 判断 */
export interface RuntimeEventCursor {
  /** 服务端本次事件流的 ID，重启后必须更换 */
  streamId: string
  /** 该流中已经消费的非负安全整数位置 */
  sequence: number
}

/** -------------------- 核心函数 -------------------- */
/**
 * 创建可放入 SSE id 与 Last-Event-ID 的游标
 */
export function createRuntimeEventCursor(cursor: RuntimeEventCursor): string {
  const { streamId, sequence } = cursor
  if (!STREAM_ID_PATTERN.test(streamId) || !Number.isSafeInteger(sequence) || sequence < 0)
    throw new TypeError('事件流游标无效')

  return `${streamId}:${sequence}`
}

/**
 * 解析游标语法，不把另一条流或超出回放窗口的游标自动当成有效位置
 */
export function parseRuntimeEventCursor(value: unknown): RuntimeEventCursor | undefined {
  if (typeof value !== 'string')
    return
  const index = value.lastIndexOf(':')
  const streamId = value.slice(0, index)
  const position = value.slice(index + 1)
  const sequence = Number(position)
  if (!STREAM_ID_PATTERN.test(streamId) || !/^(?:0|[1-9]\d*)$/u.test(position) || !Number.isSafeInteger(sequence))
    return

  return { streamId, sequence }
}
