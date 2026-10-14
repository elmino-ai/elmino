import type { Message, ModelTurnConfig, ToolCallPart, TurnModel } from '@elmino/llm'
import type { JsonValue } from '@elmino/shared'
import type { ApprovalMode } from '@elmino/store'
import type { ThreadInteractionInterrupt } from '@elmino/thread'
import type { DefinedTool, ToolApprovalInterruptPayload, ToolExecutionContext } from '@elmino/tool'
import type { PendingCall } from './types'
import { createId, isJsonValue } from '@elmino/shared'
import dayjs from 'dayjs'
import { autoReview } from './auto'
import { reviewCall } from './review'

/** -------------------- 核心函数 -------------------- */
/**
 * 读取本轮需要进入用户审批的工具调用
 */
export function findApprovalCalls(
  input: {
    /** 当前工具调用片段 */
    calls: ToolCallPart[]
    /** 当前人机交互访问级别 */
    approvalMode: ApprovalMode
    /** 当前可见工具处理器 */
    handlers: Record<string, DefinedTool>
    /** 当前工具运行能力 */
    context: Pick<ToolExecutionContext, 'sandbox' | 'signal'>
    /** 当前模型上下文消息 */
    messages: Message[]
    /** 自动审批使用的当前 Turn 模型 */
    model?: TurnModel<ModelTurnConfig>
  },
): Promise<PendingCall[]> {
  const {
    approvalMode,
    calls,
    context,
    messages,
    model,
    handlers,
  } = input

  if (approvalMode === 'fullAccess')
    return Promise.resolve([])

  const { sandbox } = context
  const targets = calls.flatMap(call =>
    reviewCall(call, handlers, sandbox),
  )

  if (targets.length === 0)
    return Promise.resolve([])

  if (approvalMode === 'request' || !model) {
    return Promise.resolve(targets.map(part => ({
      ...part,
      approvalReason: part.approvalReason ?? '请求批准模式需要用户确认',
    })))
  }

  return autoReview({
    context,
    model,
    calls: targets,
    messages,
  })
}

/**
 * 创建工具审批中断
 */
export function createApprovalInterrupt(
  turnId: string,
  calls: PendingCall[],
  handlers: Record<string, DefinedTool>,
): ThreadInteractionInterrupt {
  for (const call of calls) {
    if (!isJsonValue(call.args))
      throw new Error(`工具审批参数不是 JSON 值: ${call.name} (${call.id})`)
  }

  const payload: ToolApprovalInterruptPayload = {
    actionRequests: calls.map(call => ({
      callId: call.id,
      name: call.name,
      args: call.args as JsonValue,
      description: handlers[call.name]?.declaration.description,
      approvalReason: call.approvalReason,
    })),
    reviewConfigs: calls.map(call => ({
      actionName: call.name,
      allowedDecisions: ['approve', 'reject', 'edit', 'respond'],
    })),
  }

  return {
    id: createId('interrupt'),
    kind: 'interaction',
    interaction: 'tool_approval',
    status: 'pending',
    turnId,
    reason: '工具调用等待审批',
    payload: payload as unknown as JsonValue,
    createdAt: dayjs().toISOString(),
    resumableWith: ['interaction'],
  }
}
