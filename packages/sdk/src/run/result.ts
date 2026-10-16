import type { ThreadTarget } from '@elmino/api'
import type { ThreadState } from '@elmino/thread'
import type { ClientInteraction, ClientRunResult } from './types'
import { readThreadInteraction } from '@elmino/thread'
import { readToolApprovalPayload } from '@elmino/tool'

/**
 * 仅把指定 Turn 的终态投影为结果，线程此刻可能已经切到另一轮
 */
export function readRunResult(target: ThreadTarget & { turnId: string }, thread: ThreadState): ClientRunResult | undefined {
  /** 从权威线程时间线定位本次运行，不使用线程此刻的其他运行状态 */
  const turn = thread.turns.find(item => item.id === target.turnId)
  if (!turn || !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status))
    return
  // 读取线程当前待处理交互，随后核对它是否属于本次运行
  const interrupt = readThreadInteraction(thread.runtime.interrupt)
  // 只为本轮仍有效的待处理交互构造可直接审批或恢复的句柄
  const interaction: ClientInteraction | undefined = turn.status === 'interrupted'
    && interrupt?.status === 'pending' && interrupt.turnId === target.turnId
    ? { ...target, interruptId: interrupt.id, interrupt, approval: readToolApprovalPayload(interrupt) }
    : undefined
  // 保留本轮已确认终态，运行失败与中断作为正常结果交给宿主
  const status = turn.status as ClientRunResult['status']
  /** 选取本轮最后一条助手消息，不把其他轮次回复作为执行结果 */
  const message = thread.messages.findLast(item => item.turnId === target.turnId && item.role === 'assistant')
  // 诊断来自持久化 Turn，不依赖仍在线的执行器或事件历史
  const errorMessage = turn.message
  return { ...target, status, message, errorMessage, interaction, thread }
}
