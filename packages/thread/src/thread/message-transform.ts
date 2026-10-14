import type { JsonValue, UnknownRecord } from '@elmino/shared'
import type {
  RuntimeCanonicalPartRecord,
  RuntimeToolCallRecord,
  ThreadMessage,
  ThreadPart,
  ThreadPartStatus,
} from '@elmino/store'
import { isPlainRecord, objectPick } from '@elmino/shared'
import dayjs from 'dayjs'
import { canonicalToolResultToText } from '../context/canonical.js'
import { readThreadMentionReference } from '../input/mention.js'

/** -------------------- 类型 -------------------- */
/** 宿主投影转换为协议 Part 所需的完整归属 */
export interface ThreadPartProjectionInput {
  /** Part ID */
  id: string
  /** 所属消息 ID */
  messageId: string
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId: string
  /** 消息内顺序 */
  seq: number
  /** Runtime Part 类型 */
  type: Exclude<ThreadPart['type'], 'tool'> | 'artifact_ref'
  /** 通用展示状态 */
  status: ThreadPartStatus
  /** 文本内容 */
  text: string | null
  /** 类型专属数据 */
  json: UnknownRecord | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/** -------------------- 核心函数 -------------------- */
/**
 * 用可变 ToolCall 执行事实校准完整 transcript
 */
export function projectTranscriptMessages(
  messages: ThreadMessage[],
  toolCalls: RuntimeToolCallRecord[],
  toolResults: RuntimeCanonicalPartRecord[],
) {
  const toolCallsByMessageId = new Map<string, Map<string, RuntimeToolCallRecord>>()

  for (const toolCall of toolCalls) {
    const calls = toolCallsByMessageId.get(toolCall.assistantMessageId) ?? new Map()

    calls.set(toolCall.assistantPartId, toolCall)
    toolCallsByMessageId.set(toolCall.assistantMessageId, calls)
  }
  const toolResultByPartId = new Map(
    toolResults.map(part => [part.id, part]),
  )
  return messages.map((message) => {
    const toolCallByPartId = toolCallsByMessageId.get(message.id)
    const parts = message.parts.map((part): ThreadPart => {
      if (part.type !== 'tool')
        return part

      const toolCall = toolCallByPartId?.get(part.id)

      if (!toolCall)
        return part

      const result = toolCall.resultPartId
        ? toolResultByPartId.get(toolCall.resultPartId)
        : undefined
      const output = toolCall.resultPartId
        ? canonicalToolResultToText(result)
        : part.output

      return {
        ...part,
        status: toolCall.status,
        toolCallId: toolCall.id,
        providerCallId: toolCall.providerCallId,
        toolName: toolCall.name,
        args: toolCall.args,
        output,
        error: toolCall.errorMessage ?? undefined,
        decision: toolCall.decision ?? undefined,
        durationMs: toolCallDuration(toolCall),
        updatedAt: toolCall.completedAt ?? toolCall.startedAt ?? part.updatedAt,
      }
    })

    return {
      ...message,
      parts,
      updatedAt: parts.reduce(
        (latest, part) => part.updatedAt > latest ? part.updatedAt : latest,
        message.updatedAt,
      ),
    }
  })
}

/**
 * 将插件或 Provider 衍生数据投影成协议 Part
 */
export function projectThreadPart(
  part: ThreadPartProjectionInput,
): ThreadPart {
  const json = part.json
  const text = part.text
  const base = {
    ...objectPick(
      part,
      'id',
      'messageId',
      'turnId',
      'seq',
      'createdAt',
      'updatedAt',
    ),
    threadId: part.threadId,
    status: part.status,
  }

  if (part.type === 'text') {
    return {
      ...base,
      type: 'text',
      text: text ?? '',
    }
  }

  if (part.type === 'mention') {
    const mention = readThreadMentionReference(json)

    if (!mention)
      throw new TypeError(`Mention 片段 ${part.id} 缺少资源引用`)

    return {
      ...base,
      type: 'mention',
      ...mention,
    }
  }

  if (part.type === 'reasoning') {
    return {
      ...base,
      type: 'reasoning',
      text: text ?? jsonText(json),
      metadata: objectRecord(json?.metadata),
    }
  }

  if (part.type === 'plugin') {
    const pluginId = stringValue(json?.pluginId)
    const name = stringValue(json?.name)

    if (!pluginId || !name || !json || !('data' in json))
      throw new TypeError(`插件片段 ${part.id} 缺少命名空间或数据`)

    return {
      ...base,
      type: 'plugin',
      pluginId,
      name,
      data: json.data as JsonValue,
    }
  }

  if (part.type === 'event') {
    return {
      ...base,
      type: 'event',
      title: stringValue(json?.title) ?? text ?? 'event',
      detail: stringValue(json?.detail),
      payload: json ?? undefined,
    }
  }

  if (part.type === 'image') {
    const mime = enumValue(json?.mime, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const)
    const data = stringValue(json?.data)

    if (!mime || !data)
      throw new Error(`Runtime 图片片段缺少有效来源: ${part.id}`)

    return {
      ...base,
      type: 'image',
      name: stringValue(json?.name) ?? part.id,
      mime,
      url: `data:${mime};base64,${data}`,
    }
  }

  if (part.type === 'document') {
    const extension = stringValue(json?.extension)
    const artifactId = stringValue(json?.artifactId)

    if (!extension)
      throw new Error(`Runtime 文档片段缺少有效扩展名: ${part.id}`)
    const name = stringValue(json?.name) ?? part.id

    return {
      ...base,
      type: 'document',
      name,
      extension,
      artifactId,
    }
  }

  if (part.type === 'artifact_ref') {
    return {
      ...base,
      type: 'event',
      title: stringValue(json?.name) ?? stringValue(json?.filename) ?? 'artifact',
      detail: stringValue(json?.mime) ?? stringValue(json?.mimeType),
      payload: json ?? undefined,
    }
  }

  if (part.type === 'error') {
    return {
      ...base,
      type: 'error',
      text: text ?? jsonText(json),
    }
  }

  const exhaustivePartType: never = part.type

  return exhaustivePartType
}

/** -------------------- 内部函数 -------------------- */
/**
 * 从未知值读取字符串
 */
function stringValue(value: unknown) {
  if (typeof value === 'string')
    return value

  return undefined
}

/**
 * 从未知 JSON 字段读取受协议约束的枚举值
 */
function enumValue<TValue extends string>(
  value: unknown,
  values: readonly TValue[],
): TValue | undefined {
  return values.find(item => item === value)
}

/**
 * 从工具开始和结束事实计算耗时
 */
function toolCallDuration(toolCall: RuntimeToolCallRecord) {
  if (!toolCall.startedAt || !toolCall.completedAt)
    return

  return Math.max(0, dayjs(toolCall.completedAt).diff(dayjs(toolCall.startedAt)))
}

/**
 * 从未知值读取对象
 */
function objectRecord(value: unknown) {
  if (isPlainRecord(value))
    return value

  return undefined
}

/**
 * 将 JSON 值转成可展示文本
 */
function jsonText(value: unknown) {
  if (value === null || value === undefined)
    return ''

  return typeof value === 'string' ? value : JSON.stringify(value)
}
