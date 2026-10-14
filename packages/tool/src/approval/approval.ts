import type { JsonValue, TaggedUnion } from '@elmino/shared'
import type { ApprovalMode, RuntimeToolCallStatus, RuntimeToolDecision } from '@elmino/store'
import { isJsonValue, isOneOf, isPlainRecord } from '@elmino/shared'

/** 工具审批决策类型集合 */
const TOOL_APPROVAL_DECISION_TYPES = ['approve', 'edit', 'reject', 'respond'] as const

/** -------------------- 类型 -------------------- */
/** 人机交互访问级别 */
export type { ApprovalMode }

/** 工具审批决策类型 */
export type ToolApprovalDecisionType = typeof TOOL_APPROVAL_DECISION_TYPES[number]

/** 工具运行决策来源 */
export type ToolRuntimeDecision = RuntimeToolDecision

/** 工具运行事件状态 */
export type ToolRuntimeStatus = RuntimeToolCallStatus

/** 工具审批动作请求 */
export interface ToolApprovalActionRequest {
  /** Provider 原生工具调用 ID */
  callId: string
  /** 工具名 */
  name: string
  /** 工具参数 */
  args: JsonValue
  /** 工具说明 */
  description?: string
  /** 自动审批未放行的原因 */
  approvalReason?: string
}

/** 工具审批配置 */
export interface ToolApprovalReviewConfig {
  /** 对应工具名 */
  actionName: string
  /** 允许的审批决策 */
  allowedDecisions: ToolApprovalDecisionType[]
}

/** 工具审批中断载荷 */
export interface ToolApprovalInterruptPayload {
  /** 等待审批的动作 */
  actionRequests: ToolApprovalActionRequest[]
  /** 每个动作对应的审批配置 */
  reviewConfigs: ToolApprovalReviewConfig[]
}

/** 工具审批恢复决策 */
export type ToolApprovalDecision = TaggedUnion<'type', {
  approve: { callId: string }
  edit: { editedAction: { name: string, args: JsonValue }, callId: string }
  reject: { message?: string, callId: string }
  respond: { message: string, callId: string }
}>

/** 工具审批恢复命令 */
export interface ToolApprovalResume {
  /** 工具审批决策，必须按 callId 匹配 */
  decisions: ToolApprovalDecision[]
}

/** -------------------- 核心函数 -------------------- */
/**
 * 读取工具审批中断载荷
 */
export function readToolApprovalPayload(
  interrupt: { kind?: string, interaction?: string, payload?: unknown } | undefined,
): ToolApprovalInterruptPayload | undefined {
  if (interrupt?.kind !== 'interaction' || interrupt.interaction !== 'tool_approval')
    return
  const payload = interrupt.payload

  if (!isPlainRecord(payload))
    return

  if (
    !Array.isArray(payload.actionRequests)
    || !payload.actionRequests.every(isToolApprovalActionRequest)
    || !Array.isArray(payload.reviewConfigs)
    || !payload.reviewConfigs.every(isToolApprovalReviewConfig)
  ) {
    return
  }

  return {
    actionRequests: payload.actionRequests as unknown as ToolApprovalActionRequest[],
    reviewConfigs: payload.reviewConfigs as unknown as ToolApprovalReviewConfig[],
  }
}

/**
 * 校验工具审批 Interaction 响应及其 callId、决策权限
 */
export function readToolApprovalResponse(
  value: JsonValue,
  payload: ToolApprovalInterruptPayload,
): ToolApprovalResume | undefined {
  const decisions = isPlainRecord(value) && Array.isArray(value.decisions)
    ? value.decisions as unknown[]
    : undefined

  if (!decisions)
    return

  if (
    decisions.length !== payload.actionRequests.length
    || !decisions.every(isToolApprovalDecision)
  ) {
    return
  }

  const actionById = new Map(
    payload.actionRequests.map(action => [action.callId, action]),
  )
  const seen = new Set<string>()

  for (const decision of decisions as ToolApprovalDecision[]) {
    const action = actionById.get(decision.callId)
    const review = action
      ? payload.reviewConfigs.find(item => item.actionName === action.name)
      : undefined

    if (
      !action
      || seen.has(decision.callId)
      || !review?.allowedDecisions.includes(decision.type)
    ) {
      return
    }

    seen.add(decision.callId)
  }

  return { decisions: decisions as ToolApprovalDecision[] }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断未知值是否为完整工具审批动作
 */
function isToolApprovalActionRequest(
  value: unknown,
): value is ToolApprovalActionRequest {
  return isPlainRecord(value)
    && typeof value.callId === 'string'
    && typeof value.name === 'string'
    && isJsonValue(value.args)
    && (
      value.description === undefined
      || typeof value.description === 'string'
    )
    && (
      value.approvalReason === undefined
      || typeof value.approvalReason === 'string'
    )
}

/**
 * 判断未知值是否为完整工具审批配置
 */
function isToolApprovalReviewConfig(
  value: unknown,
): value is ToolApprovalReviewConfig {
  return isPlainRecord(value)
    && typeof value.actionName === 'string'
    && Array.isArray(value.allowedDecisions)
    && value.allowedDecisions.every(decision => (
      isOneOf(decision, TOOL_APPROVAL_DECISION_TYPES)
    ))
}

/**
 * 判断未知值是否为可执行的工具审批决策
 */
function isToolApprovalDecision(value: unknown): value is ToolApprovalDecision {
  if (
    !isPlainRecord(value)
    || typeof value.callId !== 'string'
    || !isOneOf(value.type, TOOL_APPROVAL_DECISION_TYPES)
  ) {
    return false
  }

  if (value.type === 'approve')
    return true
  if (value.type === 'reject')
    return value.message === undefined || typeof value.message === 'string'
  if (value.type === 'respond')
    return typeof value.message === 'string'

  return isPlainRecord(value.editedAction)
    && typeof value.editedAction.name === 'string'
    && isJsonValue(value.editedAction.args)
}
