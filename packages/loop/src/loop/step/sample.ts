import type { Request } from '@elmino/llm'
import type { SampleInput } from './types.js'
import { extractReasoning, extractText } from '@elmino/llm'
import { DEFAULT_MAX_TOKENS, ESCALATED_MAX_TOKENS } from '../../recovery/index.js'
import { createLiveView } from './live.js'

/** -------------------- Provider Step 采样 -------------------- */
/**
 * 执行一次 Provider sampling，并以 Result.message 作为唯一终态事实
 */
export async function sampleStep(input: SampleInput) {
  const {
    reasoning: previousReasoning = '',
    text: previousText = '',
    turn,
  } = input
  const { context, state, tools } = turn
  const { model, signal, threadId } = context
  const { adapter, config } = model
  const { reasoning } = config
  const { contextMessages: messages, recovery } = state
  const maxOutputTokens = recovery.hasEscalatedOutputBudget
    ? ESCALATED_MAX_TOKENS
    : DEFAULT_MAX_TOKENS
  const request = {
    messages,
    system: input.system,
    tools: tools.declarations,
    maxOutputTokens,
    cacheKey: threadId,
    reasoning: reasoning ? { ...reasoning.options } : undefined,
    signal,
  } satisfies Request
  const live = createLiveView(input)

  await live.start()

  try {
    // Event 只驱动 live 投影与正文检查点；仅终态 Message 能进入 Context
    const { message } = await adapter.stream(request, live.onEvent)

    return {
      status: 'completed',
      message,
      reasoning: `${previousReasoning}${extractReasoning(message)}`,
      text: `${previousText}${extractText(message)}`,
    } as const
  }
  catch (error) {
    // sampling 失败时可能立即重试，先丢弃本次未提交候选，partial 由后续决策重新校准
    await live.discard()

    return {
      status: 'failed',
      error,
      reasoning: live.readReasoning(),
      text: live.readText(),
    } as const
  }
}
