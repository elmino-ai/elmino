import type { ThreadTarget } from '@elmino/api'
import type { ThreadMessage, ThreadPart } from '@elmino/store'
import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { Client } from '../client/client'
import { readRuntimeEventMessagePayload, readRuntimeEventThreadStatePayload } from '@elmino/protocol'
import {
  applyRuntimeToolOutputDelta,
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
} from '@elmino/thread/events'
import { ORPCError } from '@orpc/client'

/** 取消本地状态观察，不会取消远端执行 */
export interface ThreadWatchOptions {
  /** 页面卸载或宿主取消时释放当前观察者 */
  signal?: AbortSignal
  /** 连接、快照或调用方投影失败的报告出口 */
  onError?: (error: unknown) => void | Promise<void>
}

/**
 * 观察线程权威快照与流式消息，不持有 UI 或查询缓存
 */
export function watchThread(
  client: Pick<Client, 'rpc'>,
  subscribe: Client['subscribe'],
  target: ThreadTarget,
  listener: (state: ThreadState) => void | Promise<void>,
  options: ThreadWatchOptions = {},
): () => void {
  // 统一取消当前观察者的快照请求与后续投影，远端任务继续运行
  const controller = new AbortController()
  // 冻结被观察线程的 Agent、工作区和身份，避免宿主后续修改目标
  const scope = { ...target }
  // 当前观察者最新接纳的完整线程投影，不跨观察者共享可变状态
  let state: ThreadState | undefined
  // 记录已成功交付宿主的快照内容，用于跳过相同状态的重复通知
  let serialized: string | undefined
  // 标记首次查询已完成，尚未创建的线程也不在同次连接重复查询
  let initialized = false
  /** 当前共享通道观察者的释放入口，取消时只移除这一个观察者 */
  let stop: (() => void) | undefined
  // 快照可能已包含尚未送达的文本 delta，因此只有本连接中的完整事件可作为无偏移增量锚点
  const anchors = new Map<string, string>()
  // 仅保留有限近期事件身份，较早历史由重置快照校准
  const recent = new Set<string>()

  /** 终止当前观察、取消在途查询并解绑宿主信号，不中断远端运行 */
  const release = () => {
    if (controller.signal.aborted)
      return
    controller.abort()
    stop?.()
    options.signal?.removeEventListener('abort', release)
  }
  options.signal?.addEventListener('abort', release, { once: true })
  if (options.signal?.aborted) {
    release()
    return release
  }

  /** 保存并交付新投影，只有宿主处理成功才确认去重基线 */
  const publish = async (next: ThreadState) => {
    if (controller.signal.aborted)
      return
    // 将当前完整投影固定为去重值，不用引用相等推测状态是否变化
    const value = JSON.stringify(next)
    state = next
    if (serialized === value)
      return
    await listener(next)
    if (!controller.signal.aborted)
      serialized = value
  }
  /** 读取权威状态并清除旧连接的文本锚点，首次未创建线程保持静默 */
  const refresh = async () => {
    anchors.clear()
    try {
      // 当前快照请求返回的完整线程，取消后的迟到结果不会再交付
      const next = await client.rpc.thread.get(scope, { signal: controller.signal })
      await publish(next)
      initialized = true
    }
    catch (error) {
      // 本地预分配的会话尚未首次运行；首个 thread.created 会再读取状态
      if (!state && error instanceof ORPCError && error.code === 'NOT_FOUND') {
        initialized = true
        return
      }
      throw error
    }
  }
  /** 合并回放消息时保留已知终态与更长正文，避免旧事件回退展示 */
  const preserveText = (message: ThreadMessage): ThreadMessage => {
    /** 按消息或片段身份定位当前投影，作为版本与增量合并的基准 */
    const current = state?.messages.find(item => item.id === message.id)
    if (!current)
      return message
    /** 生成消息的新片段集合，保留已知更完整内容或移除目标片段 */
    const parts = message.parts.map((part) => {
      /** 同一消息或片段已接纳的版本，用于拒绝过期状态覆盖 */
      const previous = current.parts.find(item => item.id === part.id)
      if (previous && ['completed', 'failed', 'skipped'].includes(previous.status)
        && ['running', 'pending'].includes(part.status) && previous.updatedAt >= part.updatedAt) {
        return previous
      }
      if ((part.type === 'text' || part.type === 'reasoning') && previous?.type === part.type
        && previous.text.length > part.text.length && previous.text.startsWith(part.text)) {
        return { ...part, text: previous.text }
      }
      return part
    })
    return { ...message, parts }
  }
  /** 按稳定消息身份更新或追加投影，同时保护新版本与已完成状态 */
  const replaceMessage = async (input: ThreadMessage) => {
    if (!state)
      return
    /** 同一消息或片段已接纳的版本，用于拒绝过期状态覆盖 */
    const previous = state.messages.find(item => item.id === input.id)
    if (previous && previous.updatedAt > input.updatedAt)
      return
    if (previous && ['completed', 'failed'].includes(previous.status)
      && ['created', 'streaming'].includes(input.status) && previous.updatedAt >= input.updatedAt) {
      return
    }
    // 经回放保护处理的完整消息，或事件中通过归属校验的消息
    const message = preserveText(input)
    /** 生成新的消息列表，保留其他消息的身份与内容 */
    const messages = state.messages.some(item => item.id === message.id)
      ? state.messages.map(item => item.id === message.id ? message : item)
      : [...state.messages, message]
    await publish({ ...state, messages })
  }
  /** 按片段身份不可变更新消息，新增片段沿持久化顺序排列 */
  const replacePart = async (message: ThreadMessage, part: ThreadPart) => {
    /** 同一消息或片段已接纳的版本，用于拒绝过期状态覆盖 */
    const previous = message.parts.find(item => item.id === part.id)
    if (previous && previous.updatedAt > part.updatedAt)
      return
    /** 生成消息的新片段集合，保留已知更完整内容或移除目标片段 */
    const parts = message.parts.some(item => item.id === part.id)
      ? message.parts.map(item => item.id === part.id ? part : item)
      : [...message.parts, part].sort((left, right) => left.seq - right.seq)
    // 取消息与片段较新的时间，避免局部更新降低消息版本
    const updatedAt = part.updatedAt > message.updatedAt ? part.updatedAt : message.updatedAt
    await replaceMessage({ ...message, parts, updatedAt })
  }

  /** 过滤已消费事实并投影流式内容，结构变化交给服务端快照校准 */
  const project = async (event: RuntimeEvent) => {
    if (controller.signal.aborted || event.threadId !== scope.threadId || recent.has(event.id))
      return
    // 事件携带的完整线程快照，版本保护后才能替换本地投影
    const thread = readRuntimeEventThreadStatePayload(event)
    if (thread) {
      anchors.clear()
      // 重连校准可能领先于回放中的完整快照，旧快照不能回退已知正文
      if (!state || thread.updatedAt >= state.updatedAt) {
        if (state && thread.updatedAt === state.updatedAt && state.runtime.turnId === thread.runtime.turnId
          && ['completed', 'failed'].includes(state.runtime.status) && thread.runtime.status === 'running') {
          return
        }
        // 生成新的消息列表，保留其他消息的身份与内容
        const messages = thread.messages.map(preserveText)
        await publish({ ...thread, messages })
      }
      return
    }
    if (!state) {
      await refresh()
      return
    }
    // 经回放保护处理的完整消息，或事件中通过归属校验的消息
    const message = readRuntimeEventMessagePayload(event)
    if (message) {
      // 从完整消息片段建立当前连接锚点，后续增量不依赖快照猜测偏移
      for (const part of message.parts) {
        if (part.type === 'text' || part.type === 'reasoning')
          anchors.set(part.id, part.text)
      }
      await replaceMessage(message)
      return
    }
    /** 当前片段所属的已知消息，缺少归属时不猜测其角色或内容 */
    const owner = state.messages.find(item => item.id === event.messageId)
    // 事件中通过线程、运行和消息归属校验的完整片段
    const part = readRuntimeEventPartPayload(event)
    if (part && owner) {
      if (part.type === 'text' || part.type === 'reasoning')
        anchors.set(part.id, part.text)
      await replacePart(owner, part)
      return
    }
    if (event.type === 'message.part.delta') {
      // 校验后的正文或工具输出增量，采用各自的定位规则合并
      const delta = readRuntimeEventPartDeltaPayload(event)?.delta
      /** 按消息或片段身份定位当前投影，作为版本与增量合并的基准 */
      const current = owner?.parts.find(item => item.id === event.partId)
      if (!delta || !owner || !current)
        return
      if ('text' in delta && (current.type === 'text' || current.type === 'reasoning')) {
        // 本连接中完整事件提供的文本基线，快照不作为无偏移增量锚点
        const anchor = anchors.get(current.id)
        if (anchor === undefined)
          return
        // 在事件锚点上追加后的正文，追上已有快照后才更新展示
        const text = anchor + delta.text
        anchors.set(current.id, text)
        // reset 的快照可领先于完整事件；锚点追上快照之前不回退已展示正文
        if (text.length >= current.text.length)
          await replacePart(owner, { ...current, text })
      }
      else if ('output' in delta && current.type === 'tool') {
        // 按字符偏移幂等合并的工具输出，缺口或冲突不会覆盖已有内容
        const output = applyRuntimeToolOutputDelta(current.output ?? '', delta)
        if (output !== undefined)
          await replacePart(owner, { ...current, output })
      }
      return
    }
    if (event.type === 'message.part.removed' && owner) {
      anchors.delete(event.partId!)
      /** 生成消息的新片段集合，保留已知更完整内容或移除目标片段 */
      const parts = owner.parts.filter(item => item.id !== event.partId)
      await replaceMessage({ ...owner, parts })
      return
    }
    // Turn 终态、审批、子线程和用量以服务端领域投影为准；逐字输出不发起快照请求
    await refresh()
  }

  try {
    stop = subscribe(scope, {
      /** 首次连接完成后补查状态，已由 reset 初始化时不重复请求 */
      onConnected: async () => {
        if (!initialized)
          await refresh()
      },
      onReset: refresh,
      /** 成功投影后才确认近期事件身份，失败重试不会越过未处理事实 */
      onEvent: async (event) => {
        await project(event)
        if (controller.signal.aborted || event.threadId !== scope.threadId)
          return
        // 只确认成功处理的事实；近期窗口有界，reset 快照负责更早的历史
        recent.add(event.id)
        if (recent.size > 1_024)
          recent.delete(recent.values().next().value!)
      },
      /** 仅向仍活跃的观察者报告错误，取消后的迟到错误不再交付宿主 */
      onError: async (error) => {
        if (!controller.signal.aborted)
          await options.onError?.(error)
      },
    })
    if (controller.signal.aborted)
      stop()
  }
  catch (error) {
    release()
    throw error
  }
  return release
}
