import type { RuntimeStore } from '@elmino/store'
import type { ThreadToolPart } from '../thread/types.js'
import dayjs from 'dayjs'
import { projectThreadPart } from '../thread/message-transform.js'

/** -------------------- 类型 -------------------- */
/** 宿主消息片段投影上下文 */
export interface LiveToolPartInput {
  /** 宿主提供的消息片段 */
  part: ThreadToolPart
  /** 所属消息 ID */
  messageId: string
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId: string
  /** 消息内稳定顺序 */
  seq: number
  /** 首次创建时间 */
  createdAt: string
}

/** -------------------- 核心函数 -------------------- */
/**
 * 将宿主消息片段投影为即时协议 part
 */
export function projectLiveToolPart(input: LiveToolPartInput) {
  const updatedAt = dayjs().toISOString()
  const record = {
    id: input.part.id,
    messageId: input.messageId,
    threadId: input.threadId,
    turnId: input.turnId,
    seq: input.seq,
    type: input.part.type,
    status: input.part.status,
    text: input.part.text ?? null,
    json: input.part.json ?? null,
    createdAt: input.createdAt,
    updatedAt,
  }

  return projectThreadPart(record)
}

/**
 * 更新已经随 Provider Step 提交的宿主消息片段
 */
export function updateToolPart(
  store: RuntimeStore,
  messageId: string,
  part: ThreadToolPart,
) {
  return store.transaction(async (tx) => {
    const updatedAt = dayjs().toISOString()
    const message = await tx.transcript.read(messageId)
    const existing = message?.parts.find(candidate => candidate.id === part.id)

    if (!message || !existing)
      throw new Error(`Transcript Part 不存在: ${part.id}`)
    const projected = part.text === undefined && part.json === undefined
      ? { ...existing, status: part.status, updatedAt }
      : projectThreadPart({
          id: part.id,
          messageId: message.id,
          threadId: message.threadId,
          turnId: message.turnId,
          seq: existing.seq,
          type: part.type,
          status: part.status,
          text: part.text ?? ('text' in existing ? existing.text : null),
          json: part.json ?? null,
          createdAt: existing.createdAt,
          updatedAt,
        })

    await tx.transcript.upsert({
      ...message,
      parts: message.parts.map(item => item.id === part.id ? projected : item),
      updatedAt,
    })

    return projected
  })
}
