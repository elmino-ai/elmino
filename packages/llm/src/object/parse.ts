import type { z } from 'zod'
import type { Message } from '../message/index.js'
import type { Result } from '../request/index.js'
import { extractText } from '../message/index.js'

/** -------------------- 类型 -------------------- */
/** 结构化对象生成结果 */
export interface ObjectResult<TSchema extends z.ZodType> extends Result {
  /** 经过 Schema 校验的对象 */
  object: z.infer<TSchema>
  /** 模型原始文本输出 */
  text: string
}

/** -------------------- 核心类 -------------------- */
/**
 * 保留完整生成结果的结构化输出解析错误
 */
export class ObjectParseError extends Error {
  /** 模型完整响应 */
  public readonly response: Message
  /** Provider 完整生成结果 */
  public readonly result: Result

  /**
   * 保存解析失败前已经完成的 Provider 响应
   */
  public constructor(result: Result, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ObjectParseError'
    this.response = result.message
    this.result = result
  }
}

/** -------------------- 核心函数 -------------------- */
/**
 * 从生成结果提取 JSON 并使用 Zod Schema 校验
 */
export function parseObject<TSchema extends z.ZodType>(
  result: Result,
  schema: TSchema,
): ObjectResult<TSchema> {
  const text = extractText(result.message)

  try {
    return {
      ...result,
      object: parseJson(text, schema),
      text,
    }
  }
  catch (error) {
    throw new ObjectParseError(result, error)
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 兼容纯 JSON、Markdown 代码块和前后说明文本
 */
function parseJson<TSchema extends z.ZodType>(text: string, schema: TSchema) {
  const fenced = readJsonFence(text)
  const candidates = Array.from(new Set([fenced, text]
    .filter((value): value is string => Boolean(value))
    .map(value => value.trim())
    .filter(Boolean)))
  let lastError: unknown

  for (const candidate of candidates) {
    try {
      return schema.parse(JSON.parse(candidate))
    }
    catch (error) {
      lastError = error
    }

    const starts = [candidate.indexOf('{'), candidate.indexOf('[')]
      .filter(index => index >= 0)
    const start = Math.min(...starts)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))

    if (starts.length === 0 || end <= start)
      continue

    try {
      return schema.parse(JSON.parse(candidate.slice(start, end + 1)))
    }
    catch (error) {
      lastError = error
    }
  }

  if (lastError)
    throw lastError

  throw new Error('未在结构化输出中找到 JSON')
}

/**
 * 从 Markdown fenced code 中读取 JSON，避免对任意模型文本执行高回溯正则
 */
function readJsonFence(text: string) {
  const marker = '```'
  const open = text.indexOf(marker)

  if (open < 0)
    return

  const lineEnd = text.indexOf('\n', open + marker.length)

  if (lineEnd < 0)
    return

  const language = text.slice(open + marker.length, lineEnd).trim().toLowerCase()

  if (language && language !== 'json')
    return

  const close = text.indexOf(marker, lineEnd + 1)

  return close < 0 ? undefined : text.slice(lineEnd + 1, close)
}
