import type { ApprovalMode, RuntimeTurnRecord, SubagentMode, ThreadMessage } from '@elmino/store'
import type { ThreadTurnState } from './state'
import { readThreadInterrupt } from '../runtime/interrupt'

/** 公开运行记录只投影冻结身份、执行策略与诊断，不暴露原始模型和 Agent 配置 */
export interface ThreadTurnRecord extends ThreadTurnState {
  /** 所属线程身份 */
  threadId: string
  /** Turn 冻结的模型配置身份 */
  modelId: string
  /** Turn 冻结的工具审批模式 */
  approvalMode: ApprovalMode
  /** Turn 冻结的子智能体模式 */
  subagentMode: SubagentMode
  /** 持久化创建时间 */
  createdAt: string
  /** 最近执行时间，未启动的排队任务使用创建时间 */
  lastEventAt: string
  /** 当前 Turn 的工具调用数量 */
  toolCallCount: number
  /** 已结算工具数量，包括失败与跳过 */
  toolResultCount: number
}

/** 按完整 Turn 边界返回一页消息，页内按执行顺序排列 */
export interface ThreadTranscriptPage {
  /** 当前页的完整 Turn 摘要 */
  turns: ThreadTurnState[]
  /** 只属于当前页 Turn 的消息 */
  messages: ThreadMessage[]
  /** 下一页更早历史游标，null 表示已经到达起点 */
  nextCursor: string | null
}

/**
 * 从同一条持久 Turn 投影冻结身份、错误与交互快照
 */
export function projectThreadTurnState(
  turn: RuntimeTurnRecord,
): ThreadTurnState & Pick<ThreadTurnRecord, 'modelId' | 'approvalMode' | 'subagentMode'> {
  // 冻结身份来自执行时保存的配置，不读取当前 Agent 或模型默认值
  const { id: agentId } = turn.agentSnapshot
  const { id: modelId } = turn.modelConfig
  if (typeof agentId !== 'string' || typeof modelId !== 'string')
    throw new Error('运行记录缺少冻结的智能体或模型身份')
  // 中断按原 Turn 读取，失败原因在重启后仍可查询
  const interrupt = readThreadInterrupt(turn.interrupt)
  const message = turn.errorMessage ?? undefined
  return {
    id: turn.id,
    status: turn.status,
    agentId,
    modelId,
    approvalMode: turn.approvalMode,
    subagentMode: turn.subagentMode,
    message,
    interrupt,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  }
}

/**
 * 沿用公开历史记录语义，从持久执行与展示消息投影最近优先的 Turn 列表
 */
export function projectThreadTurnRecords(input: {
  /** 原始持久执行记录，仅在领域内部消费 */
  turns: RuntimeTurnRecord[]
  /** 已补齐工具结果的消息，不传输原始存储记录 */
  messages: ThreadMessage[]
}): ThreadTurnRecord[] {
  // 先按 Turn 分组，避免每条运行重复遍历完整会话
  const messagesByTurn = Map.groupBy(input.messages, message => message.turnId)
  return input.turns.map((turn) => {
    // 完整记录与线程摘要共享相同的冻结身份和诊断投影
    const state = projectThreadTurnState(turn)
    const tools = (messagesByTurn.get(turn.id) ?? []).flatMap(message => (
      message.parts.filter(part => part.type === 'tool')
    ))
    const toolCallCount = tools.length
    const toolResultCount = tools.filter(part => ['completed', 'failed', 'skipped'].includes(part.status)).length
    const lastEventAt = turn.endedAt ?? turn.startedAt ?? turn.createdAt
    return {
      ...state,
      modelId: state.modelId,
      approvalMode: turn.approvalMode,
      subagentMode: turn.subagentMode,
      threadId: turn.threadId,
      createdAt: turn.createdAt,
      lastEventAt,
      toolCallCount,
      toolResultCount,
    }
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}
