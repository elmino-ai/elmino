import type { ActiveTurn } from '../turn/active'
import { appendCanonicalMessages } from '@elmino/thread'
import { createContextBudget } from '../../budget/index'
import { createSystemPrompt } from './system'

/** -------------------- 下一请求 Context 投影 -------------------- */
/**
 * 投影并持久化下一次 Provider 请求所需的 Context、system prompt 与预算
 */
export async function prepareContext(turn: ActiveTurn) {
  const {
    context,
    hooks,
    projection,
    snapshots,
    state,
    toolContext,
    tools,
  } = turn
  const { systemPrompt } = context
  // 运行时上下文属于当前请求；恢复或重启后重新解析，不作为历史消息反复累积
  const promptInput = {
    context,
    signal: context.signal,
    tools: tools.declarations,
    env: toolContext.sandbox.env,
  }
  state.stablePromptContext ??= await hooks.promptStable?.(promptInput) ?? []
  const sections = [...state.stablePromptContext, ...await hooks.promptDynamic?.(promptInput) ?? []]
  const system = createSystemPrompt(systemPrompt, sections)
  // 扩展提醒仍是追加式 Canonical 事实，不进入 UI transcript
  const messages = await hooks.promptMessages?.({
    context,
    signal: context.signal,
    messages: state.contextMessages,
  }) ?? []
  if (messages.length > 0) {
    await context.services.store.transaction(tx => appendCanonicalMessages(
      tx,
      messages.map(message => ({
        threadId: context.threadId,
        turnId: context.turnId,
        message,
      })),
    ))
  }

  // 模型请求前统一做上下文压缩，再刷新预算给 UI 和后续工具读取
  const result = await projection.beforeModelCall({
    system,
    tools: tools.declarations,
  })
  state.contextMessages.splice(
    0,
    state.contextMessages.length,
    ...result.contextMessages,
  )
  state.contextBudget = createContextBudget(
    result.usedTokens,
    state.contextMessages.length,
    context.model.config.limit.context,
    result.estimation,
  )
  await snapshots.saveProgress()
  await projection.flushEvents()

  return system
}
