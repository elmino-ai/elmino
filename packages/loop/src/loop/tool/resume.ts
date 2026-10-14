import type { ActiveTurn } from '../turn/active'
import type { TurnResumeInput } from '../types/index'
import { createToolResultPart, pendingToolCalls } from '@elmino/llm'
import { updateToolPart } from '@elmino/thread'
import { readToolApprovalPayload, readToolApprovalResponse } from '@elmino/tool'
import { executeBatch } from './batch'

/** -------------------- 类型 -------------------- */
/** Loop 恢复工具批次处理结果 */
type ResumeAction = 'continue' | 'none' | 'stop'

/** -------------------- 已提交工具批次恢复 -------------------- */
/**
 * 处理中断恢复后的待执行工具批次
 */
export async function resumeBatch(
  turn: ActiveTurn,
  resume: TurnResumeInput,
): Promise<ResumeAction> {
  const { context, emitRuntime, state } = turn
  const { store } = context.services
  const calls = pendingToolCalls(state.contextMessages)

  if (resume.toolResult || resume.part) {
    if (resume.part) {
      const callId = resume.toolResult?.callId
      const ownership = callId
        ? (await store.toolCalls.list({ turnId: context.turnId }))
            .find(toolCall => toolCall.providerCallId === callId)
        : undefined

      if (!ownership)
        throw new Error('扩展消息片段缺少 ToolCall 归属')
      const part = await updateToolPart(
        store,
        ownership.assistantMessageId,
        resume.part,
      )

      await emitRuntime('message.part.updated', { part }, {
        messageId: part.messageId,
        partId: part.id,
      })
    }

    if (resume.toolResult) {
      const { isError, output, callId } = resume.toolResult

      // 扩展结果与未处理 sibling 交给同一批执行器，确保每个工具调用只结算一次
      return executeBatch(turn, {
        calls,
        resolved: [createToolResultPart(callId, output, isError)],
      })
    }

    return 'none'
  }

  if (calls.length === 0)
    return 'none'

  const payload = readToolApprovalPayload(resume.interrupt)
  const approval = payload
    ? readToolApprovalResponse(resume.response, payload)
    : undefined

  if (!approval)
    throw new Error(`Loop Interaction 响应无效: ${resume.interrupt.interaction}`)

  // 审批恢复传入人工决议；已在中断前结算的扩展工具则直接继续 sibling
  return executeBatch(turn, {
    calls,
    resume: approval,
  })
}
