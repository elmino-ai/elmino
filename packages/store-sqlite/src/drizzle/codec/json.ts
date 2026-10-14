import type { UnknownRecord } from '@elmino/shared'
import { jsonParse } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 读取 SQLite JSON 列
 */
export function readJson(value: unknown): unknown | undefined
export function readJson(value: unknown, options: { nullable: true }): unknown | null
export function readJson(value: unknown, options?: { nullable?: boolean }) {
  if (options?.nullable && (value === null || value === undefined))
    return null

  return jsonParse(value)
}

/**
 * 读取 SQLite JSON 对象列
 */
export function readJsonObject(value: unknown): UnknownRecord
export function readJsonObject(value: unknown, options: { nullable: true }): UnknownRecord | null
export function readJsonObject(value: unknown, options?: { nullable?: boolean }) {
  if (options?.nullable && (value === null || value === undefined))
    return null

  return jsonParse(value) as UnknownRecord
}
