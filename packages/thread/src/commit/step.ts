import type { UnknownRecord } from '@elmino/shared'
import type { RuntimeStore, RuntimeStoreTx, ThreadMessage, ThreadPart, ThreadPartStatus } from '@elmino/store'
import type { ThreadToolPart } from '../thread/types.js'
import type { CheckpointInput, MessageRef, PartialCommitInput, StepCommitInput } from './types.js'
import { createToolResultPart } from '@elmino/llm'
import { createId, isPlainRecord } from '@elmino/shared'
import dayjs from 'dayjs'
import { appendCanonicalMessage } from '../context/canonical.js'
import { projectThreadPart, projectTranscriptMessages } from '../thread/message-transform.js'
import { updateThreadSnapshotTx } from '../thread/snapshot-store.js'
import { settleTurnToolsTx } from '../tool/state.js'

/** -------------------- Provider Step 持久提交 -------------------- */
/**
 * 建立或更新运行中正文与 reasoning 检查点但不修改 Provider Context
 */
export function checkpointStep(store: RuntimeStore, input: CheckpointInput) {
  return store.transaction(async (tx) => {
    const message = await readTranscript(tx, input)
    const updatedAt = dayjs().toISOString()
    const text = createTextPart(input, message, 'running', updatedAt)
    const reasoning = createReasoningPart(input, message, 'running', updatedAt)
    const parts = [
      ...(reasoning ? [reasoning] : []),
      text,
      ...message.parts.filter((part: ThreadPart) => (
        part.id !== input.textPartId && part.id !== input.reasoningPartId
      )),
    ].map((part, index) => ({ ...part, seq: index + 1 }))

    await tx.transcript.upsert({ ...message, status: 'streaming', parts, updatedAt })

    return parts.find(part => part.id === input.textPartId)!
  })
}

/**
 * 在 Turn 终态事务内统一结算 transcript 检查点与工具输出
 */
export async function settleTurnOutputTx(
  tx: RuntimeStoreTx,
  threadId: string,
  turnId: string,
  status: 'failed' | 'interrupted',
  reason: string,
  settledAt: string,
) {
  await settleTurnToolsTx(tx, threadId, turnId, reason)
  const messages = await tx.transcript.list(threadId, [turnId])

  for (const message of messages) {
    if (message.status !== 'streaming')
      continue

    const parts = message.parts.map((part: ThreadPart): ThreadPart => (
      part.type === 'tool' || (part.status !== 'running' && part.status !== 'pending')
        ? part
        : {
            ...part,
            status: status === 'failed' ? 'failed' : 'completed',
            updatedAt: settledAt,
          }
    ))

    await tx.transcript.upsert({ ...message, status, parts, updatedAt: settledAt })
  }
}

/**
 * 原子提交完整 Provider Message、UI transcript、下一轮 Context 与工具归属
 */
export async function persistStep(store: RuntimeStore, input: StepCommitInput) {
  const executeTools = input.toolFailure === undefined
  const projections = new Map<string, {
    /** 当前工具是否由宿主接管消息投影 */
    handled: boolean
    /** 宿主提供的自定义消息片段 */
    part?: ThreadToolPart
  }>()

  // 宿主投影必须在事务外物化，事务内只允许确定性的 Store 写入
  for (const part of input.message.parts) {
    if (part.type !== 'tool-call' || !executeTools)
      continue

    projections.set(part.id, await input.projectToolPart({ part, phase: 'completed' }))
  }

  return store.transaction(async (tx) => {
    const message = await readTranscript(tx, input)
    const updatedAt = dayjs().toISOString()
    const outputParts = new Map<string, ThreadPart>(
      message.parts
        .filter((part: ThreadPart) => (
          part.id !== input.textPartId && part.id !== input.reasoningPartId
        ))
        .map((part: ThreadPart) => [part.id, part]),
    )
    const partIds: Array<string | undefined> = []
    const failedTools: Array<{
      /** Runtime ToolCall ID */
      toolCallId: string
      /** Provider ToolCall ID */
      providerCallId: string
      /** 工具名 */
      name: string
      /** 工具失败原因 */
      error: string
      /** Canonical ToolResultPart ID */
      resultPartId: string
    }> = []

    for (const part of input.message.parts) {
      if (part.type !== 'tool-call') {
        partIds.push(undefined)

        if (part.type !== 'text' && part.type !== 'reasoning') {
          const id = createId('part')

          outputParts.set(id, projectThreadPart({
            id,
            messageId: message.id,
            threadId: message.threadId,
            turnId: message.turnId,
            seq: outputParts.size + 3,
            type: 'artifact_ref',
            status: 'completed',
            text: null,
            json: toObjectJson(part),
            createdAt: updatedAt,
            updatedAt,
          }))
        }
        continue
      }

      const projection = projections.get(part.id)
      const hidden = projection?.handled || input.hiddenTools[part.name]
      const status = executeTools ? 'pending' : 'failed'
      const assistantPartId = `${input.messageId}:tool:${part.id}`
      const toolPart = createToolPart(
        message,
        assistantPartId,
        part.id,
        part.name,
        part.args,
        status,
        updatedAt,
        hidden,
      )

      outputParts.set(toolPart.id, toolPart)
      partIds.push(assistantPartId)
      const runtimeToolCall = await tx.toolCalls.create({
        turnId: input.turnId,
        assistantMessageId: input.messageId,
        assistantPartId,
        providerCallId: part.id,
        name: part.name,
        args: part.args,
        status,
      })

      if (input.toolFailure) {
        failedTools.push({
          toolCallId: runtimeToolCall.id,
          providerCallId: part.id,
          name: part.name,
          error: input.toolFailure,
          resultPartId: createId('canonical_part'),
        })
      }
      if (projection?.handled && projection.part) {
        const projected = projection.part

        outputParts.set(projected.id, projectThreadPart({
          id: projected.id,
          messageId: message.id,
          threadId: message.threadId,
          turnId: message.turnId,
          seq: outputParts.size + 3,
          type: projected.type,
          status: projected.status,
          text: projected.text ?? null,
          json: projected.json ?? null,
          createdAt: outputParts.get(projected.id)?.createdAt ?? updatedAt,
          updatedAt,
        }))
      }
    }

    await appendCanonicalMessage(tx, {
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      partIds,
    })

    for (const failed of failedTools) {
      await appendCanonicalMessage(tx, {
        threadId: input.threadId,
        turnId: input.turnId,
        message: {
          role: 'tool',
          parts: [{
            ...createToolResultPart(failed.providerCallId, failed.error, true),
            name: failed.name,
          }],
        },
        partIds: [failed.resultPartId],
      })
      await tx.toolCalls.update(failed.toolCallId, {
        completedAt: updatedAt,
        errorMessage: failed.error,
        resultPartId: failed.resultPartId,
      })
    }

    const reasoning = createReasoningPart(input, message, 'completed', updatedAt)
    const text = createTextPart(input, message, 'completed', updatedAt)
    const parts = [
      ...(reasoning ? [reasoning] : []),
      text,
      ...outputParts.values(),
    ].map((part, index) => ({ ...part, seq: index + 1 }))
    const transcript: ThreadMessage = {
      ...message,
      status: 'completed',
      parts,
      updatedAt,
      metadata: { stopReason: input.message.finishReason },
    }
    const toolCalls = (await tx.toolCalls.list({ turnId: input.turnId }))
      .filter(toolCall => toolCall.assistantMessageId === transcript.id)
    const toolResults = await tx.canonical.readParts(
      input.threadId,
      toolCalls.flatMap((toolCall: { resultPartId: string | null }) => (
        toolCall.resultPartId ? [toolCall.resultPartId] : []
      )),
    )
    const [projected] = projectTranscriptMessages([transcript], toolCalls, toolResults)

    // transcript 保存 UI 结构；终态工具输出只由 Canonical ToolResult 持有并在读取时投影
    await tx.transcript.upsert(transcript)
    await updateThreadSnapshotTx(tx, input.threadId, input.snapshot)

    return projected!
  })
}

/**
 * 原子提交失败或中断前可安全展示的 partial 文本与未变化 Context
 */
export function persistPartial(store: RuntimeStore, input: PartialCommitInput) {
  return store.transaction(async (tx) => {
    const message = await readTranscript(tx, input)
    const updatedAt = dayjs().toISOString()
    const partStatus = input.status === 'failed' ? 'failed' : 'completed'
    const reasoning = createReasoningPart(input, message, partStatus, updatedAt)
    const text = createTextPart(input, message, partStatus, updatedAt)
    const transcript: ThreadMessage = {
      ...message,
      status: input.status,
      parts: [
        ...(reasoning ? [reasoning] : []),
        text,
        ...message.parts.filter((part: ThreadPart) => (
          part.id !== input.textPartId && part.id !== input.reasoningPartId
        )),
      ].map((part, index) => ({ ...part, seq: index + 1 })),
      updatedAt,
    }

    await tx.transcript.upsert(transcript)
    await updateThreadSnapshotTx(tx, input.threadId, input.snapshot)

    return transcript
  })
}

/** -------------------- 内部函数 -------------------- */
/**
 * 读取或创建当前 Provider Step 的完整 transcript
 */
async function readTranscript(
  tx: RuntimeStoreTx,
  input: MessageRef,
): Promise<ThreadMessage> {
  const existing = await tx.transcript.read(input.messageId)

  if (existing)
    return existing

  const createdAt = dayjs().toISOString()

  const transcript = {
    id: input.messageId,
    threadId: input.threadId,
    turnId: input.turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    parts: [],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  } satisfies ThreadMessage

  await tx.transcript.upsert(transcript)

  return transcript
}

/**
 * 创建当前 transcript 的稳定正文 Part
 */
function createTextPart(
  input: MessageRef & { text: string },
  message: ThreadMessage,
  status: ThreadPartStatus,
  updatedAt: string,
) {
  const existing = message.parts.find(part => part.id === input.textPartId)

  return {
    id: input.textPartId,
    messageId: message.id,
    threadId: message.threadId,
    turnId: message.turnId,
    seq: 1,
    type: 'text',
    status,
    text: input.text,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  } satisfies ThreadPart
}

/**
 * 创建非空或已经存在的稳定 reasoning Part
 */
function createReasoningPart(
  input: MessageRef & { reasoning: string },
  message: ThreadMessage,
  status: ThreadPartStatus,
  updatedAt: string,
) {
  const existing = message.parts.find(part => part.id === input.reasoningPartId)

  if (!input.reasoning && !existing)
    return

  return {
    id: input.reasoningPartId,
    messageId: message.id,
    threadId: message.threadId,
    turnId: message.turnId,
    seq: 1,
    type: 'reasoning',
    status,
    text: input.reasoning,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  } satisfies ThreadPart
}

/**
 * 创建显式绑定 ToolCall 的 transcript 工具 Part
 */
function createToolPart(
  message: ThreadMessage,
  id: string,
  providerCallId: string,
  toolName: string,
  args: UnknownRecord,
  status: ThreadPartStatus,
  updatedAt: string,
  hidden?: boolean,
) {
  const existing = message.parts.find(part => part.id === id)

  return {
    id,
    messageId: message.id,
    threadId: message.threadId,
    turnId: message.turnId,
    seq: 1,
    type: 'tool',
    status,
    providerCallId,
    toolName,
    args,
    hidden: Boolean(hidden) || undefined,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  } satisfies ThreadPart
}

/**
 * 将未知 JSON 值收窄成对象
 */
function toObjectJson(value: unknown): UnknownRecord {
  if (isPlainRecord(value))
    return value

  return { value }
}
