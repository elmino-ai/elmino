import type { ToolResultPart } from '@elmino/llm'
import type {
  RuntimeStore,
  RuntimeStoreTx,
  RuntimeToolCallRecord,
  RuntimeToolCallStatus,
  RuntimeToolDecision,
  ThreadToolPart,
  UpdateRuntimeToolCallInput,
} from '@elmino/store'
import type { RuntimeEvent, RuntimeEventType } from '../runtime/event.js'
import { createToolResultPart } from '@elmino/llm'
import { createId } from '@elmino/shared'
import dayjs from 'dayjs'
import { appendCanonicalMessage } from '../context/canonical.js'
import { projectTranscriptMessages } from '../thread/message-transform.js'

/** -------------------- 类型 -------------------- */
/** 结构化运行事件输出 */
export type RuntimeEmitter = (
  type: RuntimeEventType,
  payload: unknown,
  scope?: Partial<Pick<
    RuntimeEvent,
    'interruptId' | 'messageId' | 'partId' | 'toolCallId'
  >>,
) => Promise<void>

/** 工具状态写入入参 */
export interface CommitToolStateInput {
  /** RuntimeStore 实例 */
  store: RuntimeStore
  /** 结构化运行事件输出 */
  emitRuntime: RuntimeEmitter
  /** 当前工具调用归属 */
  ownership: RuntimeToolCallRecord
  /** 工具运行状态 */
  status: RuntimeToolCallStatus
  /** 审批决策 */
  decision: RuntimeToolDecision
  /** 开始时间 */
  startedAt?: string
  /** 完成时间 */
  completedAt?: string
  /** 错误信息 */
  errorMessage?: string
  /** 完整工具输出 */
  output?: string
  /** 原样写入 Canonical Context 的结构化工具结果 */
  result?: ToolResultPart
}

/** -------------------- 核心函数 -------------------- */
/**
 * 原子提交工具执行事实与对应 transcript Part，再发布非权威 Runtime Event
 */
export async function commitToolState(input: CommitToolStateInput) {
  const {
    completedAt,
    decision,
    emitRuntime,
    errorMessage,
    output,
    result,
    ownership,
    startedAt,
    status,
    store,
  } = input

  const updatedAt = completedAt ?? dayjs().toISOString()

  // ToolCall 保存执行事实，transcript 只保存完整 UI 投影
  const [updatedToolCall, updatedPart] = await store.transaction(async (tx) => {
    const toolCallUpdate: UpdateRuntimeToolCallInput = {
      status,
      decision,
    }

    if (startedAt !== undefined)
      toolCallUpdate.startedAt = startedAt
    if (completedAt !== undefined)
      toolCallUpdate.completedAt = completedAt
    if (errorMessage !== undefined)
      toolCallUpdate.errorMessage = errorMessage
    let canonicalResult

    if (status !== 'pending' && status !== 'running') {
      const resultPartId = createId('canonical_part')
      const resultText = status === 'completed'
        ? output ?? ''
        : output || errorMessage || ''
      const resultPart = result
        ? {
            ...result,
            name: result.name ?? ownership.name,
            ...(output !== undefined ? { output } : {}),
          }
        : {
          ...createToolResultPart(
            ownership.providerCallId,
            resultText,
            status !== 'completed',
          ),
          name: ownership.name,
          ...(output !== undefined ? { output } : {}),
        } satisfies ToolResultPart
      const message = await appendCanonicalMessage(tx, {
        threadId: ownership.threadId,
        turnId: ownership.turnId,
        message: { role: 'tool', parts: [resultPart] },
        partIds: [resultPartId],
      })

      canonicalResult = message.parts[0]
      toolCallUpdate.resultPartId = resultPartId
    }

    const toolCall = await tx.toolCalls.update(ownership.id, toolCallUpdate)
    const transcript = await tx.transcript.read(toolCall.assistantMessageId)

    if (!transcript)
      throw new Error(`工具调用缺少 transcript: ${toolCall.id}`)
    const checkpoint = transcript.parts.find(part => part.id === toolCall.assistantPartId)

    if (!checkpoint || checkpoint.type !== 'tool')
      throw new Error(`工具调用缺少 transcript Part: ${toolCall.id}`)
    const [projected] = projectTranscriptMessages(
      [transcript],
      [toolCall],
      canonicalResult ? [canonicalResult] : [],
    )
    const projectedPart = projected?.parts.find(part => part.id === toolCall.assistantPartId)

    if (!projected || !projectedPart || projectedPart.type !== 'tool')
      throw new Error(`工具调用缺少 transcript Part: ${toolCall.id}`)
    const part = output === undefined || canonicalResult
      ? projectedPart
      : { ...projectedPart, output, updatedAt }
    const storedPart = createToolCheckpoint(
      checkpoint,
      toolCall.status,
      updatedAt,
      canonicalResult ? undefined : output,
    )

    await tx.transcript.upsert({
      ...transcript,
      parts: transcript.parts.map(item => item.id === storedPart.id ? storedPart : item),
      updatedAt,
    })

    return [toolCall, part] as const
  })

  await emitRuntime('message.part.updated', { part: updatedPart }, {
    messageId: updatedPart.messageId,
    partId: updatedPart.id,
    toolCallId: updatedToolCall.id,
  })
}

/**
 * 在 Turn 终态事务内结算工具归属，并为完整批次补齐可重放结果
 */
export async function settleTurnToolsTx(
  store: RuntimeStoreTx,
  threadId: string,
  turnId: string,
  reason: string,
) {
  const tools = await store.toolCalls.list({ turnId })
  const completedAt = dayjs().toISOString()

  for (const tool of tools) {
    if (tool.status !== 'pending' && tool.status !== 'running')
      continue

    const resultPartId = createId('canonical_part')
    const result = {
      ...createToolResultPart(tool.providerCallId, reason, true),
      name: tool.name,
    } satisfies ToolResultPart

    await appendCanonicalMessage(store, {
      threadId,
      turnId,
      message: { role: 'tool', parts: [result] },
      partIds: [resultPartId],
    })

    await store.toolCalls.update(tool.id, {
      status: 'failed',
      completedAt,
      errorMessage: reason,
      resultPartId,
    })
    const transcript = await store.transcript.read(tool.assistantMessageId)

    if (!transcript)
      throw new Error(`工具调用缺少 transcript: ${tool.id}`)
    const checkpoint = transcript.parts.find(part => part.id === tool.assistantPartId)

    if (!checkpoint || checkpoint.type !== 'tool')
      throw new Error(`工具调用缺少 transcript Part: ${tool.id}`)
    const storedPart = createToolCheckpoint(checkpoint, 'failed', completedAt)

    await store.transcript.upsert({
      ...transcript,
      parts: transcript.parts.map(part => part.id === storedPart.id ? storedPart : part),
      updatedAt: completedAt,
    })
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 只保存工具展示结构与运行中输出，终态执行事实统一由 ToolCall 和 Canonical 持有
 */
function createToolCheckpoint(
  part: ThreadToolPart,
  status: ThreadToolPart['status'],
  updatedAt: string,
  output?: string,
): ThreadToolPart {
  const {
    decision: _decision,
    durationMs: _durationMs,
    error: _error,
    output: previousOutput,
    providerCallId: _providerCallId,
    toolCallId: _toolCallId,
    ...checkpoint
  } = part
  const savedOutput = output ?? (
    status === 'pending' || status === 'running'
      ? previousOutput
      : undefined
  )

  return {
    ...checkpoint,
    status,
    ...(savedOutput === undefined ? {} : { output: savedOutput }),
    updatedAt,
  }
}
