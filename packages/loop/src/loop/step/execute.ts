import type { Message } from '@elmino/llm'
import type { ActiveTurn } from '../turn/active.js'
import type { SampleInput, StepResult } from './types.js'
import { attachToolResults, createToolResultPart, toolCalls as readToolCalls } from '@elmino/llm'
import { createId, objectEntries, objectFromEntries } from '@elmino/shared'
import { appendCanonicalMessage } from '@elmino/thread'
import { isTransientProviderError, withRetry } from '../../recovery/index.js'
import { prepareContext } from '../context/prepare.js'
import { executeBatch } from '../tool/batch.js'
import { decideError, decideMessage } from './decision.js'
import { sampleStep } from './sample.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 按 Context 准备、sampling、决策、持久提交和工具门顺序执行一个 Step
 */
export async function executeStep(turn: ActiveTurn): Promise<StepResult> {
  if (turn.context.signal?.aborted)
    throw new Error('运行已中断')

  const { committer, context, hooks, snapshots, state, tools } = turn
  const { signal } = context
  const {
    messageId: _messageId,
    reasoning = '',
    reasoningPartId: _reasoningPartId,
    text = '',
    textPartId: _textPartId,
  } = state.recovery.outputContinuation ?? {}
  const messageId = _messageId ?? createId('msg')
  const reasoningPartId = _reasoningPartId ?? createId('part')
  const textPartId = _textPartId ?? createId('part')
  const system = await prepareContext(turn)
  const sample: SampleInput = {
    turn,
    messageId,
    textPartId,
    reasoningPartId,
    system,
    reasoning,
    text,
  }

  // transient retry 只重跑 sampling，不提交中间候选，也不污染 Provider Context
  while (true) {
    let retryableFailure: Awaited<ReturnType<typeof sampleStep>> | undefined
    const sampling = await withRetry(async () => {
      retryableFailure = undefined
      const result = await sampleStep(sample)

      if (
        result.status === 'failed'
        && !signal?.aborted
        && isTransientProviderError(result.error)
      ) {
        retryableFailure = result
        throw result.error
      }

      return result
    }, signal).catch(error => (
      retryableFailure?.status === 'failed'
        ? retryableFailure
        : {
            status: 'failed' as const,
            error,
            reasoning,
            text,
          }
    ))

    if (sampling.status === 'failed') {
      const decision = await decideError(sample, sampling.error)

      if (decision.action === 'retry') {
        await snapshots.saveProgress()
        await turn.projection.flushEvents()
        continue
      }

      // 失败 partial 只保存安全展示文本，snapshot 中的 Provider Context 保持不变
      const status = decision.status
      const { reasoning, text } = sampling
      const snapshot = await snapshots.materialize(status, {
        errorMessage: 'errorMessage' in decision
          ? decision.errorMessage
          : undefined,
      })
      const committedMessage = await committer.commitPartial({
        messageId,
        textPartId,
        reasoningPartId,
        reasoning,
        text,
        status,
        snapshot,
      })

      if (status === 'failed') {
        await Promise.all([
          publishCommittedMessage(turn, committedMessage),
          snapshots.publishBudget(),
          turn.emitRuntime('turn.failed', decision.failure, {
            messageId,
          }),
        ])
      }
      else {
        await Promise.all([
          publishCommittedMessage(turn, committedMessage),
          snapshots.publishBudget(),
          turn.emitRuntime('turn.interrupted', {
            reason: decision.reason,
          }, {
            messageId,
          }),
        ])
      }

      return { action: 'stop' }
    }

    const {
      message,
      reasoning: responseReasoning,
      text: responseText,
    } = sampling

    // 完整 Message 原样进入 canonical Context，reasoning 私有字段不在此处投影或改写
    if (hasReplayableContent(message))
      state.contextMessages.push(message)
    const decision = decideMessage(
      sample,
      message,
      responseText,
      responseReasoning,
    )
    const calls = readToolCalls(message.parts)
    const readyCalls = decision.calls ?? []
    const runsTools = readyCalls.length > 0
    let toolFailure: string | undefined

    if (!runsTools && calls.length > 0) {
      const reason = `Provider 以 ${message.finishReason ?? 'unknown'} 结束，工具调用未执行`

      toolFailure = reason
      attachToolResults(
        state.contextMessages,
        calls.map(call => createToolResultPart(call.id, reason, true)),
      )
    }

    if (runsTools) {
      await hooks.onLifecycle?.('tool.batch.started', {
        context,
        signal: context.signal,
        payload: { parts: readyCalls },
      })
    }
    const snapshot = await snapshots.materialize(
      decision.status === 'running' ? undefined : decision.status,
      {
        errorMessage: 'errorMessage' in decision
          ? decision.errorMessage
          : undefined,
      },
    )
    const hiddenTools = objectFromEntries(
      objectEntries(tools.handlers)
        .map(([name, tool]) => [name, tool.hidden] as const),
    )
    // 单一事务同时落最终 transcript、下一轮 Context snapshot 和工具归属
    const committedMessage = await committer.commitStep({
      messageId,
      textPartId,
      reasoningPartId,
      message,
      toolFailure,
      reasoning: responseReasoning,
      text: responseText,
      snapshot,
      hiddenTools,
      projectToolPart: async input => await hooks.projectTool?.({
        ...input,
        context,
        signal: context.signal,
      }) ?? { handled: false },
    })
    const requestPrompt = state.recovery.requestPrompt

    if (requestPrompt) {
      await context.services.store.transaction(tx => appendCanonicalMessage(tx, {
        threadId: context.threadId,
        turnId: context.turnId,
        message: requestPrompt,
      }))
      state.contextMessages.push(requestPrompt)
      state.recovery.requestPrompt = undefined
    }
    const notifications: Promise<unknown>[] = [
      publishCommittedMessage(turn, committedMessage),
      snapshots.publishBudget(),
    ]

    if (decision.status === 'completed') {
      notifications.push(turn.emitRuntime('turn.completed', {
        stopReason: message.finishReason,
      }))
    }
    else if (decision.status === 'failed') {
      notifications.push(
        turn.emitRuntime('turn.failed', decision.failure, {
          messageId,
        }),
      )
    }

    // 持久事实已经提交，Runtime 推送失败不能触发 Provider 重试或阻止工具执行
    await Promise.all(notifications)

    // 只有事务提交成功返回后，工具副作用才允许开始
    if (runsTools) {
      const action = await executeBatch(turn, {
        calls: readyCalls,
      })

      return action === 'continue' ? { action } : { action, message }
    }

    return decision.action === 'continue'
      ? { action: decision.action }
      : { action: decision.action, message }
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 发布已持久化的完整 ThreadMessage
 */
function publishCommittedMessage(
  turn: ActiveTurn,
  message: Awaited<ReturnType<ActiveTurn['committer']['commitStep']>>,
) {
  const firstPart = message.parts[0]

  return turn.emitRuntime('message.updated', { message }, {
    messageId: message.id,
    partId: firstPart?.id,
  })
}

/**
 * 判断完整 Message 是否包含下一次 Provider 请求可回放的内容
 */
function hasReplayableContent(message: Message) {
  return message.parts.some(part => (
    part.type === 'text'
      ? part.text.trim().length > 0
      : part.type !== 'reasoning'
        || part.text.trim().length > 0
        || Boolean(part.signature)
  ))
}
