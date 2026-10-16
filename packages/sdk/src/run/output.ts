import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { ClientObserveOptions } from './types'
import { readRuntimeEventMessagePayload } from '@elmino/protocol'
import { readRuntimeEventPartDeltaPayload, readRuntimeEventPartPayload } from '@elmino/thread/events'

/** 当前订阅中有完整锚点的正文；与已经交给调用方的输出长度分开保存 */
interface TextCursor {
  /** 正文或可见思考 */
  type: 'text' | 'reasoning'
  /** 此连接中从完整片段累积的原始内容 */
  text: string
}

/**
 * 一次运行的输出投影；事件和快照共用输出位置，快照不能充当后续无偏移 delta 的锚点
 */
export function createRunOutput(options: ClientObserveOptions, signal: AbortSignal) {
  // 记录已交给宿主的正文长度，快照补齐与回放共用输出位置
  const lengths = new Map<string, number>()
  // 只保存连接中完整事件提供的文本锚点，重置时清除
  const anchors = new Map<string, TextCursor>()
  // 记录已通知的工具终态，恢复或快照补齐不重复展示
  const tools = new Set<string>()
  // 记录本轮成功投影的事件身份，避免回放重复调用宿主回调
  const events = new Set<string>()
  // 保存完整消息确认的角色，避免把用户输入误当助手输出
  const roles = new Map<string, string>()

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

  /** 统一投影正文、思考和可见工具终态，完整事件可同时建立增量锚点 */
  const parts = async (values: ThreadState['messages'][number]['parts'], anchor: boolean) => {
    // 逐个处理当前消息片段，输出去重按片段身份而不是事件顺序保存
    for (const part of values) {
      signal.throwIfAborted()
      if (part.type === 'text' || part.type === 'reasoning') {
        // 当前正文片段的类型与完整内容，供锚点和输出去重共用
        const value = { type: part.type, text: part.text }
        if (anchor)
          anchors.set(part.id, value)
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
      anchors.clear()
      // 只遍历当前快照中的消息，按 Turn 和角色筛选本次可见输出
      for (const message of state.messages) {
        if (message.turnId !== turnId)
          continue
        roles.set(message.id, message.role)
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
     * reset 后旧连接的无偏移 delta 已无法定位，等完整锚点或最终快照补齐
     */
    reset() {
      anchors.clear()
    },
    /**
     * 只投影本轮助手输出，旧会话消息不会重新交给回调
     */
    async snapshot(state: Pick<ThreadState, 'messages'>, turnId: string) {
      // 只遍历当前快照中的消息，按 Turn 和角色筛选本次可见输出
      for (const message of state.messages) {
        if (message.turnId !== turnId)
          continue
        roles.set(message.id, message.role)
        if (message.role === 'assistant')
          await parts(message.parts, false)
      }
    },
    /**
     * 订阅已经按 Thread / Turn 过滤；成功投影后才记住事件身份
     */
    async event(event: RuntimeEvent) {
      if (events.has(event.id))
        return
      // 事件中通过归属校验的完整消息，用于确认角色和补齐内容
      const message = readRuntimeEventMessagePayload(event)
      if (message) {
        roles.set(message.id, message.role)
        if (message.role === 'assistant')
          await parts(message.parts, true)
      }
      // 事件中通过归属校验的完整片段，未知消息角色时只保留锚点
      const part = readRuntimeEventPartPayload(event)
      if (part && roles.get(part.messageId) !== 'user' && roles.get(part.messageId) !== 'system') {
        // 流式正文的首个锚点可能早于完整 assistant 消息；此处只记锚点，不展示未知角色
        if (part.type === 'text' || part.type === 'reasoning')
          anchors.set(part.id, { type: part.type, text: part.text })
        if (roles.get(part.messageId) === 'assistant')
          await parts([part], true)
      }
      // 从领域事件读取的正文或工具输出增量，文本必须结合本连接锚点
      const delta = readRuntimeEventPartDeltaPayload(event)?.delta
      // 当前片段在本连接中的完整文本锚点，缺省时不猜测无偏移增量位置
      const cursor = event.partId ? anchors.get(event.partId) : undefined
      // 文本 delta 是 assistant 专属事件；没有锚点时等完整片段，避免 reset 后重复追加
      if (event.partId && delta && 'text' in delta && cursor) {
        cursor.text += delta.text
        await text(event.partId, cursor)
      }
      signal.throwIfAborted()
      await options.onEvent?.(event)
      events.add(event.id)
    },
  }
}
