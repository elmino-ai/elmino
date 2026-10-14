import type { Message } from '@elmino/llm'
import type { SampleInput } from './types.js'
import { toolCalls as readToolCalls } from '@elmino/llm'
import { createContextBudget } from '../../budget/index.js'
import {
  CONTINUATION_PROMPT,
  EMPTY_RESPONSE_REMINDER_PROMPT,
  isPromptTooLongError,
  MAX_CONTINUATION_RETRIES,
  MAX_EMPTY_RESPONSE_RETRIES,
} from '../../recovery/index.js'

/** -------------------- Step 生命周期决策 -------------------- */
/**
 * 根据完整 Provider Message 更新恢复状态并决定提交后的动作
 */
export function decideMessage(
  input: SampleInput,
  message: Message,
  text: string,
  reasoning: string,
) {
  const { messageId, reasoningPartId, textPartId, turn } = input
  const { state } = turn
  const { recovery } = state

  recovery.requestPrompt = undefined

  if (message.finishReason === 'truncated') {
    recovery.outputContinuation = {
      messageId,
      reasoningPartId,
      textPartId,
      reasoning,
      text,
    }
    recovery.hasEscalatedOutputBudget = true

    if (recovery.continuationCount < MAX_CONTINUATION_RETRIES) {
      recovery.continuationCount++
      recovery.requestPrompt = {
        role: 'user',
        parts: [{ type: 'text', text: CONTINUATION_PROMPT }],
      }

      return { action: 'continue', status: 'running' } as const
    }

    recovery.outputContinuation = undefined
    return { action: 'stop', status: 'completed' } as const
  }

  recovery.outputContinuation = undefined

  if (message.finishReason === 'tool-calls') {
    const calls = readToolCalls(message.parts)

    if (calls.length > 0 && calls.every(call => !call.invalidArgs)) {
      return {
        action: 'continue',
        status: 'running',
        calls,
      } as const
    }
    // 非法参数仍接回错误 ToolResult，让模型有机会在下一 Step 自行纠正
    if (calls.length > 0)
      return { action: 'continue', status: 'running' } as const
  }

  if (hasVisibleAssistantContent(message)) {
    recovery.emptyResponseCount = 0
    return { action: 'stop', status: 'completed' } as const
  }

  if (recovery.emptyResponseCount >= MAX_EMPTY_RESPONSE_RETRIES) {
    const errorMessage = '连续收到空回复且没有工具调用，已停止以避免伪完成'

    return {
      action: 'stop',
      status: 'failed',
      errorMessage,
      failure: {
        message: errorMessage,
        prefix: '[错误] 空回复',
      },
    } as const
  }

  recovery.emptyResponseCount++
  recovery.requestPrompt = {
    role: 'user',
    parts: [{ type: 'text', text: EMPTY_RESPONSE_REMINDER_PROMPT }],
  }

  return { action: 'continue', status: 'running' } as const
}

/**
 * 根据 Provider 错误更新恢复状态并决定重试或终止
 */
export async function decideError(
  input: SampleInput,
  error: unknown,
) {
  const { system, turn } = input
  const { context, projection, state, tools } = turn
  const { model, signal } = context
  const { contextMessages } = state
  const maxTokens = model.config.limit.context
  const promptTooLong = isPromptTooLongError(error)

  if (signal?.aborted) {
    return {
      action: 'stop',
      status: 'interrupted',
      reason: signal.reason ?? 'aborted',
    } as const
  }

  if (promptTooLong && !state.recovery.hasAttemptedReactiveCompact) {
    contextMessages.splice(
      0,
      contextMessages.length,
      ...await projection.compactHistory(),
    )
    const budget = await projection.countInput(contextMessages, {
      system,
      tools: tools.declarations,
    })

    state.contextBudget = createContextBudget(
      budget.usedTokens,
      contextMessages.length,
      maxTokens,
      budget.estimation,
    )
    state.recovery.hasAttemptedReactiveCompact = true

    return { action: 'retry' } as const
  }

  const errorMessage = error instanceof Error
    ? error.message
    : String(error)
  const prefix = promptTooLong
    ? '[Error] Context too large after reactive compact.'
    : `[Error] ${error instanceof Error
      ? error.name
      : 'UnknownError'}`

  return {
    action: 'stop',
    status: 'failed',
    errorMessage,
    failure: {
      message: errorMessage,
      prefix,
    },
  } as const
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断 assistant 消息是否已经产生面向用户的实际输出
 */
function hasVisibleAssistantContent(message: Message) {
  return message.parts.some((part) => {
    if (part.type === 'reasoning')
      return false
    if (part.type === 'text')
      return part.text.trim().length > 0

    return true
  })
}
