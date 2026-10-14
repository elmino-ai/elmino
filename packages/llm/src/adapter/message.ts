import type { FinishReason, Message, Part, ToolCallPart } from '../message/index.js'
import { isPlainRecord } from './record.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 从未知 Provider 字段读取非负整数
 */
export function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

/**
 * 保留 Provider 原始对象供诊断
 */
export function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined
}

/**
 * 用最终参数草稿创建工具调用 Part
 */
export function createToolCall(
  id: string,
  name: string,
  argsText: string,
  metadata?: Record<string, unknown>,
): ToolCallPart {
  const parsed = readToolArgs(argsText)

  return {
    type: 'tool-call',
    id,
    name,
    args: parsed.args,
    argsText,
    metadata,
    ...(!parsed.valid ? { invalidArgs: true as const } : {}),
  }
}

/**
 * 创建不携带终态参数校验的流式工具身份
 */
export function createToolCallStart(
  id: string,
  name: string,
  metadata?: Record<string, unknown>,
): ToolCallPart {
  return {
    type: 'tool-call',
    id,
    name,
    args: {},
    argsText: '',
    metadata,
  }
}

/**
 * 创建标准化 assistant 消息
 */
export function createAssistantMessage(input: {
  id?: string
  parts: Part[]
  finishReason: FinishReason
  rawFinishReason?: string | null
  metadata?: Record<string, unknown>
}): Message {
  return {
    role: 'assistant',
    id: input.id,
    parts: input.parts,
    finishReason: input.finishReason,
    rawFinishReason: input.rawFinishReason,
    metadata: input.metadata,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 解析工具参数并保留最终草稿是否完整的事实
 */
function readToolArgs(value: string | undefined) {
  if (!value)
    return { args: {}, valid: false } as const

  try {
    const args = JSON.parse(value)

    return isPlainRecord(args)
      ? { args, valid: true } as const
      : { args: {}, valid: false } as const
  }
  catch {
    return { args: {}, valid: false } as const
  }
}
