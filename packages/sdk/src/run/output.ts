import type { ThreadState } from '@elmino/thread'
import type { ClientObserveOptions } from './types'

/** 当前订阅中有完整锚点的正文；与已经交给调用方的输出长度分开保存 */
interface TextCursor {
  /** 正文或可见思考 */
  type: 'text' | 'reasoning'
  /** 此连接中从完整片段累积的原始内容 */
  text: string
}

/**
 * 只从统一线程投影交付本轮新增输出，不再解释原始事件或维护另一套正文锚点
 */
export function createRunOutput(options: ClientObserveOptions, signal: AbortSignal) {
  // 记录已交给宿主的正文长度，快照补齐与回放共用输出位置
  const lengths = new Map<string, number>()
  // 记录已通知的工具终态，恢复或快照补齐不重复展示
  const tools = new Set<string>()

  /** 按已展示长度交付新增正文或思考，成功回调后才推进输出位置 */
  const text = async (id: string, value: TextCursor) => {
    signal.throwIfAborted()
    // 当前片段已交付给宿主的字符数量，不依赖重连后的事件数量
    const length = lengths.get(id) ?? 0
    // 完整正文中尚未交付的尾部，保留原始空白格式
    const delta = value.text.slice(length)
    if (!delta || !value.text.trim())
      return
    if (value.type === 'text')
      await options.onText?.(delta)
    else
      await options.onReasoning?.(delta)
    lengths.set(id, Math.max(length, value.text.length))
  }

  /** 交付正文、思考和可见工具终态，成功回调后才推进位置 */
  const parts = async (values: ThreadState['messages'][number]['parts']) => {
    // 逐个处理当前消息片段，输出去重按片段身份而不是事件顺序保存
    for (const part of values) {
      signal.throwIfAborted()
      if (part.type === 'text' || part.type === 'reasoning') {
        // 当前正文片段的类型与完整内容，供锚点和输出去重共用
        const value = { type: part.type, text: part.text }
        await text(part.id, value)
      }
      if (part.type === 'tool' && !part.hidden && ['completed', 'failed', 'skipped'].includes(part.status) && !tools.has(part.id)) {
        await options.onToolResult?.(part)
        tools.add(part.id)
      }
    }
  }

  return {
    /**
     * 恢复原 Turn 前建立已展示基线，不再次输出审批前的正文和已完成工具
     */
    seed(state: Pick<ThreadState, 'messages'>, turnId: string) {
      // 只遍历当前快照中的消息，按 Turn 和角色筛选本次可见输出
      for (const message of state.messages) {
        if (message.turnId !== turnId)
          continue
        if (message.role !== 'assistant')
          continue
        // 逐个处理当前消息片段，输出去重按片段身份而不是事件顺序保存
        for (const part of message.parts) {
          if (part.type === 'text' || part.type === 'reasoning')
            lengths.set(part.id, part.text.length)
          if (part.type === 'tool' && ['completed', 'failed', 'skipped'].includes(part.status))
            tools.add(part.id)
        }
      }
    },
    /**
     * 只投影本轮助手输出，旧会话消息不会重新交给回调
     */
    async snapshot(state: Pick<ThreadState, 'messages'>, turnId: string) {
      // 只遍历当前快照中的消息，按 Turn 和角色筛选本次可见输出
      for (const message of state.messages) {
        if (message.turnId !== turnId)
          continue
        if (message.role === 'assistant')
          await parts(message.parts)
      }
    },
  }
}
