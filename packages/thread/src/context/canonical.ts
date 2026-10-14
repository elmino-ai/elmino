import type { Message, Part } from '@elmino/llm'
import type {
  AppendRuntimeCanonicalMessageInput,
  RuntimeCanonicalMessageWithParts,
  RuntimeCanonicalPartRecord,
  RuntimeStoreTx,
} from '@elmino/store'
import { objectKeys, objectOmit } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** Canonical Message 追加参数 */
export interface AppendCanonicalMessageInput {
  /** 当前线程 ID */
  threadId: string
  /** 首次写入该消息的 Turn ID */
  turnId: string
  /** 完整 Provider Message */
  message: Message
  /** 与 Message parts 等序的本地稳定 Part ID */
  partIds?: Array<string | undefined>
}

/** -------------------- 核心函数 -------------------- */
/**
 * 追加一条不可变 Provider Message，并返回包含本地 Part ID 的 Canonical 事实
 */
export function appendCanonicalMessage(
  store: RuntimeStoreTx,
  input: AppendCanonicalMessageInput,
) {
  return store.canonical.append(createCanonicalInput(input))
}

/**
 * 按输入顺序追加多条不可变 Provider Message
 */
export function appendCanonicalMessages(
  store: RuntimeStoreTx,
  inputs: AppendCanonicalMessageInput[],
) {
  return store.canonical.appendMany(inputs.map(createCanonicalInput))
}

/**
 * 将完整 Canonical 记录恢复为 Provider Message
 */
export function canonicalRecordToMessage(
  record: RuntimeCanonicalMessageWithParts,
): Message {
  return {
    role: record.role,
    // 展示用 output 留在原始记录中，模型上下文与摘要只恢复工具 result
    parts: record.parts.map(({ content }) => (
      content.type === 'tool-result' ? objectOmit(content, 'output') : content
    ) as unknown as Part),
    ...(record.providerId ? { id: record.providerId } : {}),
    ...(record.finishReason
      ? { finishReason: record.finishReason as Message['finishReason'] }
      : {}),
    ...(record.rawFinishReason !== null
      ? { rawFinishReason: record.rawFinishReason }
      : {}),
    ...(objectKeys(record.metadata).length > 0
      ? { metadata: record.metadata }
      : {}),
  }
}

/**
 * 将 Canonical ToolResultPart 的结构化结果投影成 transcript 文本
 */
export function canonicalToolResultToText(part?: RuntimeCanonicalPartRecord) {
  const content = part?.content

  if (!content || content.type !== 'tool-result' || !('result' in content))
    return
  if (typeof content.output === 'string')
    return content.output

  return typeof content.result === 'string'
    ? content.result
    : JSON.stringify(content.result)
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将 LLM Message 转换成不丢失 Provider 字段的 Store 追加输入
 */
function createCanonicalInput(
  input: AppendCanonicalMessageInput,
): AppendRuntimeCanonicalMessageInput {
  const {
    message,
    partIds,
    threadId,
    turnId,
  } = input

  return {
    threadId,
    turnId,
    role: message.role,
    providerId: message.id,
    finishReason: message.finishReason,
    rawFinishReason: message.rawFinishReason,
    metadata: message.metadata,
    parts: [
      ...message.parts.map((part, index) => ({
        id: partIds?.[index],
        type: part.type,
        content: part as unknown as Record<string, unknown>,
      })),
    ],
  }
}
