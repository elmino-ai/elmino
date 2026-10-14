import type { ToolCallPart, ToolResultContent, ToolResultPart } from '@elmino/llm'
import type { RuntimeToolCallStatus as ToolRuntimeStatus } from '@elmino/store'
import type { ToolExecutionContext } from '@elmino/tool'
import type { ToolInvocation } from './types.js'
import { createToolResultPart } from '@elmino/llm'
import { commitToolState } from '@elmino/thread'
import dayjs from 'dayjs'
import { applyApproval, decisionOutput } from '../../approval/index.js'
import { runHandler, throwIfAborted } from './handler.js'

/** -------------------- 类型 -------------------- */
/** 单个工具调用状态更新 */
interface ToolStateUpdate {
  /** 工具运行状态 */
  status: ToolRuntimeStatus
  /** 完成时间 */
  completedAt?: string
  /** 错误信息 */
  errorMessage?: string
  /** 当前输出 */
  output?: string
  /** 原样写入 Canonical Context 的结构化工具结果 */
  result?: ToolResultPart
}

/** 单个工具调用完成后交给批次统一接回 Provider 上下文的结果 */
interface InvocationResult {
  /** Provider 工具结果 Part */
  result: ToolResultPart
  /** 需要在批次完整收束后继续向上抛出的真实执行错误 */
  failure?: { error: unknown }
}

/** -------------------- 常量 -------------------- */
/** running 工具输出最短持久化间隔 */
const OUTPUT_SAVE_INTERVAL_MS = 10_000

/** 扩展工具限制拒绝，作为失败工具结果返回而不终止 Turn */
class ToolDeniedError extends Error {}

/** -------------------- 已提交工具调用 -------------------- */
/**
 * 执行单个已提交且已放行的工具调用，并先提交终态再返回 Provider 结果
 */
export async function executeInvocation(
  invocation: ToolInvocation,
): Promise<InvocationResult> {
  const { turn } = invocation
  const {
    call: originalCall,
    decision,
    decisionType,
    ownership,
  } = invocation
  const {
    context,
    emitRuntime,
    hooks,
    tools,
    toolContext,
  } = turn
  const { signal } = toolContext
  const { store } = turn.context.services
  const { handlers } = tools
  let call = applyApproval(originalCall, decision)
  const humanOutput = decisionOutput(originalCall, decision)
  const startedAt = dayjs().toISOString()
  const scope = {
    messageId: ownership.assistantMessageId,
    partId: ownership.assistantPartId,
    toolCallId: ownership.id,
  }

  /** 使用当前工具调用的稳定归属写入状态 */
  const commitState = (update: ToolStateUpdate) => commitToolState({
    store,
    emitRuntime,
    ownership,
    decision: decisionType,
    startedAt,
    ...update,
  })

  /** 写入跳过工具执行的最终状态 */
  const finishSkipped = async (output: string): Promise<InvocationResult> => {
    const completedAt = dayjs().toISOString()
    const result = createToolResultPart(originalCall.id, output)

    await commitState({
      status: 'skipped',
      completedAt,
      output,
      result,
    })

    return { result }
  }

  let additionalContext: string | undefined
  let streamed = ''
  let saved = ''
  let savedAt = 0
  let progressQueue = Promise.resolve()
  let output = ''
  let content: ToolResultContent | undefined
  let status: ToolRuntimeStatus = 'completed'
  let errorMessage: string | undefined
  let failure: unknown
  let shouldPropagate = false

  try {
    throwIfAborted(signal)

    if (humanOutput !== undefined)
      return finishSkipped(humanOutput)

    const before = await hooks.beforeTool?.({
      context,
      signal: context.signal,
      part: call,
    })

    throwIfAborted(signal)

    if (before && 'updatedArgs' in before) {
      call = {
        ...call,
        args: before.updatedArgs as ToolCallPart['args'],
      }
    }
    additionalContext = before?.additionalContext

    if (before?.decision === 'block') {
      return finishSkipped(
        before.reason ?? `工具 ${call.name} 被扩展阻止执行`,
      )
    }

    const handler = handlers[call.name]

    // 工具限制在审批和 before 改写后再次校验，参数编辑不能绕过扩展声明的作用范围
    const accessDenial = hooks.authorizeTool?.(
      handler,
      call.args,
      toolContext,
      context,
    )

    if (accessDenial)
      throw new ToolDeniedError(accessDenial)

    // before 改写先完成，再写入权威运行态，保证事件、审批参数和真实执行参数一致
    await commitState({
      status: 'running',
    })

    const reviewInput = handler?.review?.(call.args)
    const grants = reviewInput
      ? toolContext.sandbox.reviewer.approval(reviewInput).grants ?? []
      : []
    const executionSandbox = grants.length > 0
      ? toolContext.sandbox.withGrants(grants)
      : toolContext.sandbox
    const executionContext: ToolExecutionContext = {
      ...toolContext,
      sandbox: executionSandbox,
      toolCallId: ownership.id,
      onToolProgress: (outputDelta) => {
        if (!outputDelta)
          return

        // stdout 和 stderr 可以并发到达；串行队列固定累计文本、偏移和事件顺序
        progressQueue = progressQueue.then(async () => {
          const offset = streamed.length

          streamed += outputDelta
          await emitRuntime('message.part.delta', {
            delta: { output: outputDelta, offset },
          }, scope)

          const now = dayjs().valueOf()
          const shouldSave = !saved
            || now - savedAt >= OUTPUT_SAVE_INTERVAL_MS

          if (!shouldSave)
            return

          saved = streamed
          savedAt = now
          await commitState({
            status: 'running',
            output: streamed,
          })
        })

        return progressQueue
      },
    }
    const result = await runHandler({
      call,
      handlers,
      toolContext: executionContext,
    })

    await progressQueue
    output = result.output
    content = result.content
    status = result.status
    errorMessage = result.errorMessage
    throwIfAborted(signal)

    // 工具执行成功后再触发后置扩展，允许扩展处理运行事件和状态快照
    await hooks.afterTool?.({
      context,
      signal: context.signal,
      part: call,
      status,
      output,
    })
    throwIfAborted(signal)
  }
  catch (error) {
    const interrupted = signal?.aborted
    failure = error
    shouldPropagate = !(error instanceof ToolDeniedError)
    status = 'failed'
    errorMessage = interrupted
      ? '运行已中断'
      : error instanceof Error ? error.message : String(error)
    output ||= streamed
  }

  const completedAt = dayjs().toISOString()
  const fallback = output
    || (status === 'failed' ? errorMessage ?? '工具执行失败' : '')
  content ??= fallback
  if (additionalContext) {
    const contextText = `扩展附加上下文：\n${additionalContext}`

    content = typeof content === 'string'
      ? `${content}\n\n${contextText}`
      : [...content, { type: 'text', text: contextText }]
  }
  const result = createToolResultPart(
    originalCall.id,
    content,
    status === 'failed',
  )

  // 完整 ToolCall 和 message.part.updated 是终态权威，异常和中断也必须离开 running 生命周期
  await commitState({
    status,
    completedAt,
    errorMessage,
    output,
    result,
  })

  return {
    result,
    failure: shouldPropagate ? { error: failure } : undefined,
  }
}

/**
 * 将因批次提前失败而未完成的工具调用结算为终态结果
 */
export async function settleInvocation(
  invocation: ToolInvocation,
  input: {
    /** 工具最终状态 */
    status: 'failed' | 'skipped'
    /** 失败或跳过原因 */
    errorMessage: string
  },
) {
  const { call, decisionType: decision, ownership, turn } = invocation
  const { errorMessage, status } = input
  const { emitRuntime } = turn
  const { store } = turn.context.services
  const startedAt = ownership.startedAt ?? undefined
  const completedAt = dayjs().toISOString()
  const output = `错误：${errorMessage}`
  const result = createToolResultPart(call.id, output, true)

  await commitToolState({
    store,
    emitRuntime,
    ownership,
    decision,
    startedAt,
    completedAt,
    status,
    errorMessage,
    output,
    result,
  })

  return result
}
