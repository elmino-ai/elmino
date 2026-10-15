import type { JsonValue } from '@elmino/shared'
import { isJsonValue } from '@elmino/shared'
import { z } from 'zod'

/** JSON Schema 的实例本身是 JSON，六类联合覆盖任意深度且无需相对引用 */
export const jsonValueMetadata = {
  type: ['string', 'number', 'boolean', 'null', 'array', 'object'],
  description: '任意 JSON 值；不包含 undefined、非有限数字、函数或循环引用',
}

/** 外部 JSON 数据边界，元数据只描述传输结构，不替代运行时校验 */
export const JsonValueSchema = z.custom<JsonValue>(isJsonValue).meta({ jsonSchema: jsonValueMetadata })
