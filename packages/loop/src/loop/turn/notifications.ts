import type { ThreadMessage } from '@elmino/store'
import type { ExecutionNotification } from '../../hooks/index'
import type { TurnRuntimeEventEmitter } from '../types/index'
import { createId } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建只通过 Runtime Event 展示且在 Turn 结束时统一清理的通知器
 */
export function createTurnNotifications(options: {
  threadId: string
  turnId: string
  emitRuntime: TurnRuntimeEventEmitter
}) {
  const { emitRuntime, threadId, turnId } = options
  const active = new Set<() => Promise<void>>()

  /** 发布一条拥有完整消息身份的临时通知 */
  const show = async (input: ExecutionNotification & {
    status?: 'completed' | 'running'
  }) => {
    const createdAt = new Date().toISOString()
    const messageId = createId('msg')
    const partId = createId('part')
    const status = input.status ?? 'completed'
    /** 删除当前通知，重复调用不再发布事件 */
    const remove = async () => {
      if (!active.delete(remove))
        return

      await emitRuntime('message.part.removed', {}, { messageId, partId })
    }
    const message: ThreadMessage = {
      id: messageId,
      threadId,
      turnId,
      role: 'system',
      kind: 'synthetic',
      status: status === 'running' ? 'streaming' : 'completed',
      parts: [{
        id: partId,
        messageId,
        threadId,
        turnId,
        seq: 1,
        type: 'event',
        status,
        title: input.title,
        detail: input.detail,
        payload: input.payload,
        createdAt,
        updatedAt: createdAt,
      }],
      createdAt,
      updatedAt: createdAt,
      metadata: {},
    }

    active.add(remove)
    await emitRuntime('message.updated', { message }, { messageId, partId })

    return remove
  }

  /** 按创建顺序清除本 Turn 尚未删除的全部临时通知 */
  const clear = async () => {
    for (const remove of active)
      await remove()
  }

  return { clear, show }
}
