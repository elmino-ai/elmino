import type { ToolCallPart, ToolResultPart } from '@elmino/llm'
import type { ToolApprovalResume } from '@elmino/tool'
import type { ToolInterruptResult } from '../../hooks/index'
import type { ActiveTurn } from '../turn/active'
import { createToolResultPart } from '@elmino/llm'
import { canonicalToolResultToText, commitToolState, updateToolPart } from '@elmino/thread'
import dayjs from 'dayjs'
import { createApprovalInterrupt, findApprovalCalls, readApprovalDecisions } from '../../approval/index'
import { executeInvocation, settleInvocation } from './invocation'

/** -------------------- 已提交工具批次 -------------------- */
/**
 * 执行已由 Step 提交工具归属的调用批次，并在返回前补齐 Provider 结果
 */
export async function executeBatch(
  turn: ActiveTurn,
  batch: {
    /** 当前工具调用片段 */
    calls: ToolCallPart[]
    /** 恢复审批命令 */
    resume?: ToolApprovalResume
    /** 恢复阶段已由扩展结算的 Provider 结果 */
    resolved?: ToolResultPart[]
  },
): Promise<'continue' | 'stop'> {
  const {
    context,
    emitRuntime,
    hooks,
    projection,
    snapshots,
    state,
    tools,
    toolContext,
  } = turn
  const {
    approvalMode,
    model,
    turnId,
  } = context
  const { store } = context.services
  const { saveProgress, saveOutcome } = snapshots
  const { handlers } = tools
  const { calls, resolved = [], resume } = batch
  const results = new Map<string, ToolResultPart>()
  const ownerships = new Map(
    (await store.toolCalls.list({ turnId })).map(toolCall => [
      toolCall.providerCallId,
      toolCall,
    ]),
  )

  // 缺少 ownership 表示调用绕过了 Step commit，任何工具副作用都不得开始

  /** 将扩展直接返回的结果结算到标准工具归属 */
  const commitInterceptedResult = async (call: ToolCallPart, result: ToolResultPart) => {
    const ownership = ownerships.get(call.id)

    if (!ownership)
      throw new Error(`工具调用缺少已持久化归属: ${call.id}`)
    const output = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result)

    await commitToolState({
      store,
      emitRuntime,
      ownership,
      decision: 'auto',
      status: result.error ? 'failed' : 'completed',
      completedAt: dayjs().toISOString(),
      errorMessage: result.error ? output : undefined,
      output,
      result,
    })
  }

  /** 按 Provider 原始工具调用顺序读取已结算结果 */
  const orderedResults = () => calls.flatMap((call) => {
    const result = results.get(call.id)

    return result ? [result] : []
  })

  /** 按原始调用顺序将完整批次结果接回 Provider Context 并保存快照 */
  const persistResults = async () => {
    state.contextMessages.splice(
      0,
      state.contextMessages.length,
      ...await projection.project(),
    )
    await saveProgress()
    await projection.flushEvents()
  }

  /** 应用扩展接管的工具结果或中断 */
  const applyInterceptedResult = async (
    call: ToolCallPart,
    result: ToolInterruptResult,
  ): Promise<'continue' | 'stop'> => {
    let messageId: string | undefined

    if (result.part) {
      const ownership = ownerships.get(call.id)
      const part = ownership
        ? await updateToolPart(
            store,
            ownership.assistantMessageId,
            result.part,
          ).catch(() => undefined)
        : undefined

      if (part) {
        messageId = part.messageId
        await emitRuntime('message.part.updated', { part }, {
          messageId,
          partId: part.id,
        })
      }
    }

    if (!result.interrupt) {
      const output = result.output ?? ''
      const toolResult = createToolResultPart(call.id, output, result.isError)

      await commitInterceptedResult(call, toolResult)
      results.set(call.id, toolResult)
      return 'continue'
    }

    if (result.output !== undefined) {
      const toolResult = createToolResultPart(
        call.id,
        result.output,
        result.isError,
      )

      await commitInterceptedResult(call, toolResult)
      results.set(call.id, toolResult)
    }

    // 中断前已生成的结果必须先持久化，恢复时只处理未结算 sibling
    if (orderedResults().length > 0) {
      state.contextMessages.splice(
        0,
        state.contextMessages.length,
        ...await projection.project(),
      )
    }

    await saveOutcome('interrupted', { interrupt: result.interrupt })
    await emitRuntime('turn.interrupted', result.interrupt, {
      interruptId: result.interrupt.id,
      messageId,
      partId: result.part?.id ?? result.partId,
    })

    return 'stop'
  }

  const decisions = readApprovalDecisions(resume)
  /** 读取指定工具片段在当前执行或恢复中的审批事实 */
  const readDecision = (call: ToolCallPart) => {
    const approved = { type: 'approve' as const, callId: call.id }
    const decision = resume
      ? decisions.get(call.id) ?? approved
      : approved

    return {
      decision,
      decisionType: resume ? decision.type : 'auto' as const,
    }
  }

  /** 在真实错误向上抛出前补齐本批所有工具的终态和 Provider 结果 */
  const settleBatch = async (
    rejections: Map<string, unknown>,
    error: unknown,
  ) => {
    const reason = context.signal?.aborted
      ? '运行已中断'
      : error instanceof Error ? error.message : String(error)
    const latestOwnerships = new Map(
      (await store.toolCalls.list({ turnId })).map(toolCall => [
        toolCall.providerCallId,
        toolCall,
      ]),
    )

    for (const call of calls) {
      if (results.has(call.id))
        continue

      const ownership = latestOwnerships.get(call.id)!

      if (ownership.status !== 'pending' && ownership.status !== 'running') {
        const result = ownership.resultPartId
          ? await store.canonical.readPart(
              ownership.threadId,
              ownership.resultPartId,
            )
          : undefined
        const output = canonicalToolResultToText(result)
          || ownership.errorMessage
          || `工具调用已${ownership.status}`

        results.set(call.id, createToolResultPart(
          call.id,
          output,
          ownership.status === 'failed',
        ))
        continue
      }

      const { decision, decisionType } = readDecision(call)
      const rejected = rejections.has(call.id)
      const cause = rejections.get(call.id)
      const status = rejected ? 'failed' : 'skipped'
      const errorMessage = status === 'failed'
        ? context.signal?.aborted
          ? '运行已中断'
          : cause instanceof Error ? cause.message : String(cause)
        : `工具批次已终止，未执行: ${reason}`

      results.set(call.id, await settleInvocation({
        turn,
        call,
        decision,
        decisionType,
        ownership,
      }, {
        status,
        errorMessage,
      }))
    }

    // assistant 中本批全部工具调用必须在同一条 tool 消息里得到等序工具结果
    await persistResults()
  }
  const rejections = new Map<string, unknown>()

  try {
    // 恢复结果和扩展接管都先结算 ownership，再进入普通审批与执行
    for (const result of resolved) {
      const call = calls.find(call => call.id === result.callId)

      if (!call)
        throw new Error(`恢复的工具结果缺少调用事实: ${result.callId}`)
      await commitInterceptedResult(call, result)
      results.set(call.id, result)
    }

    if (!resume) {
      // 非中断扩展结果可能不止一个，必须逐个消费后再进入普通工具审批
      while (true) {
        let intercepted: { part: ToolCallPart, result: ToolInterruptResult } | undefined
        for (const part of calls.filter(call => !results.has(call.id))) {
          const result = await hooks.interceptTool?.({ context, part, signal: context.signal })
          if (result) {
            intercepted = { part, result }
            break
          }
        }

        if (!intercepted)
          break
        const action = await applyInterceptedResult(intercepted.part, intercepted.result)

        if (action === 'stop')
          return action
      }
    }

    const unresolved = calls.filter(call => !results.has(call.id))
    const reviewable: ToolCallPart[] = []

    for (const call of unresolved) {
      // 工具限制在普通审批前收窄可用集合，审批策略不能扩大扩展声明的作用范围
      const accessDenial = resume
        ? undefined
        : hooks.authorizeTool?.(
            handlers[call.name],
            call.args,
            toolContext,
            context,
          )

      if (!accessDenial) {
        reviewable.push(call)
        continue
      }

      const ownership = ownerships.get(call.id)!
      const { decision, decisionType } = readDecision(call)

      results.set(call.id, await settleInvocation({
        turn,
        call,
        decision,
        decisionType,
        ownership,
      }, {
        status: 'failed',
        errorMessage: accessDenial,
      }))
    }

    // 工具限制只收窄可执行集合；随后才根据审批模式决定是否中断 Turn
    const pending = resume
      ? undefined
      : await findApprovalCalls({
          approvalMode,
          calls: reviewable,
          context: toolContext,
          messages: state.contextMessages,
          model,
          handlers,
        })

    if (pending && pending.length > 0) {
      // 已恢复的扩展结果先落入上下文，下次审批恢复只会找到未结算 sibling
      if (orderedResults().length > 0) {
        state.contextMessages.splice(
          0,
          state.contextMessages.length,
          ...await projection.project(),
        )
      }

      const interrupt = createApprovalInterrupt(
        turnId,
        pending,
        handlers,
      )

      await saveOutcome('interrupted', { interrupt })
      await emitRuntime('turn.interrupted', interrupt, {
        interruptId: interrupt.id,
      })

      return 'stop'
    }

    // 连续 opt-in 调用共享一个并发波次，默认串行工具负责等待前序并阻挡后序
    const executable = calls.filter(call => !results.has(call.id))

    for (let start = 0; start < executable.length;) {
      const first = executable[start]!
      const parallel = handlers[first.name]?.parallel === true
      let end = start + 1

      if (parallel) {
        while (
          end < executable.length
          && handlers[executable[end]!.name]?.parallel === true
        ) {
          end++
        }
      }

      const wave = executable.slice(start, end)
      const failures = await Promise.all(wave.map(async (call) => {
        const ownership = ownerships.get(call.id)!
        // 恢复审批时复用人工决策，否则按自动通过执行原始工具片段
        const { decision, decisionType } = readDecision(call)

        try {
          const result = await executeInvocation({
            turn,
            call,
            decision,
            decisionType,
            ownership,
          })

          results.set(call.id, result.result)
          return result.failure
        }
        catch (error) {
          rejections.set(call.id, error)
          return { error }
        }
      }))
      const failure = failures.find(result => result !== undefined)

      if (failure)
        throw failure.error

      start = end
    }

    // 所有调用离开 pending/running 后，统一写入等序 ToolResult Message
    await persistResults()
    return 'continue'
  }
  catch (error) {
    await settleBatch(rejections, error)
    throw error
  }
}
