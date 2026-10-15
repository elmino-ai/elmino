import type { RuntimeEvent } from '@elmino/thread/events'
import type { RuntimeStreamMessage } from './types'
import { isPlainRecord, jsonParse } from '@elmino/shared'
import { RuntimeEventSchema, RuntimeStreamMessageSchema } from './schema'

/** -------------------- 核心函数 -------------------- */
/**
 * 校验未知运行事件及其完整载荷
 */
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return RuntimeEventSchema.safeParse(value).success
}

/**
 * 校验运行事件或事件流控制消息
 */
export function isRuntimeStreamMessage(value: unknown): value is RuntimeStreamMessage {
  return RuntimeStreamMessageSchema.safeParse(value).success
}

/**
 * 解析来自持久化文本或 HTTP 的事件，格式错误返回 undefined
 */
export function parseRuntimeEventJson(text: string): RuntimeEvent | undefined {
  const value = jsonParse(text)
  return isRuntimeEvent(value) ? value : undefined
}

/**
 * 解析事件流 JSON，控制消息与事实事件共用严格边界
 */
export function parseRuntimeStreamMessageJson(text: string): RuntimeStreamMessage | undefined {
  const value = jsonParse(text)
  return isRuntimeStreamMessage(value) ? value : undefined
}

/**
 * 序列化前核对 JSON 可表示性，序列化后校验领域载荷与归属
 */
export function serializeRuntimeEvent(event: RuntimeEvent): string {
  assertSerializable(event)
  const text = JSON.stringify(event)
  if (!parseRuntimeEventJson(text))
    throw new TypeError('运行事件无法通过传输校验')

  return text
}

/** -------------------- 内部函数 -------------------- */
/**
 * 对象中的可选 undefined 字段遵循 JSON 省略语义，其余有损值拒绝静默转换
 */
function assertSerializable(value: unknown, ancestors = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean')
    return
  if (typeof value === 'number' && Number.isFinite(value))
    return
  if ((!Array.isArray(value) && !isPlainRecord(value)) || ancestors.has(value))
    throw new TypeError('运行事件包含无法传输的 JSON 数据')

  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || value[index] === undefined)
        throw new TypeError('运行事件数组包含空值位置')
      assertSerializable(value[index], ancestors)
    }
  }
  else {
    for (const item of Object.values(value))
      assertSerializable(item, ancestors)
  }
  ancestors.delete(value)
}
