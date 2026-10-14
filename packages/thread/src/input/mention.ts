import type { ThreadMentionReference } from '@elmino/store'
import { isJsonValue, isPlainRecord } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 从未知数据读取有效 Mention 引用
 */
export function readThreadMentionReference(value: unknown): ThreadMentionReference | undefined {
  if (!isPlainRecord(value))
    return

  const { data, label, pluginId, resourceId, trigger } = value

  if (
    typeof pluginId !== 'string'
    || !pluginId
    || typeof resourceId !== 'string'
    || !resourceId
    || typeof trigger !== 'string'
    || !/^\S$/u.test(trigger)
    || typeof label !== 'string'
    || !label.trim()
    || (data !== undefined && !isJsonValue(data))
  ) {
    return
  }

  return {
    pluginId,
    resourceId,
    trigger,
    label,
    ...(data === undefined ? {} : { data }),
  }
}
