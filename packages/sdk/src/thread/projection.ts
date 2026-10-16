import type { ThreadMessage, ThreadPart } from '@elmino/store'
import type { ThreadState } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import { readRuntimeEventMessagePayload, readRuntimeEventThreadStatePayload } from '@elmino/protocol'
import { deepEqual } from '@elmino/shared'
import {
  applyRuntimeToolOutputDelta,
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
} from '@elmino/thread/events'

/** 一次事实投影的当前快照与权威查询需求，由会话统一安排读取和通知 */
interface ThreadProjectionResult {
  /** 没有变化时保持原引用，删除或尚未读取线程时为空 */
  state: ThreadState | undefined
  /** 结构事实或流缺口需要外层重新读取权威快照 */
  refresh: boolean
}

/** 最近已成功本地投影的事件窗口，旧连接更早的历史由快照校准 */
const RECENT_EVENT_LIMIT = 1_024

/** 单个会话的纯事实投影，不拥有连接、请求、调度器或界面状态 */
export class ThreadProjection {
  /** 当前权威快照与已接纳增量合成的唯一线程状态 */
  private _state: ThreadState | undefined
  /** 无偏移文本只接在本连接完整事件提供的基线上，查询快照不能充当锚点 */
  private readonly _anchors = new Map<string, string>()
  /** 只记录不依赖外部查询的已消费事实，避免查询失败后吞掉重投事件 */
  private readonly _recent = new Set<string>()
  /** 清空或删除使此前在途读取失效，普通校准不改变所属会话的读取代次 */
  private _epoch = 0
  /** 所属工作区真实传输连接的重置身份，多个观察者共用同一次边界 */
  private _connection: object | undefined

  /**
   * 创建由会话句柄独占的投影
   */
  public static create(): ThreadProjection {
    return new ThreadProjection()
  }

  /**
   * 初始化不含任何权威数据的本地投影
   */
  private constructor() {}

  /**
   * 用查询结果开始新的流基线，保留已知更新事实并清除旧连接的锚点
   */
  public reset(state?: ThreadState): ThreadState | undefined {
    this._anchors.clear()
    this._recent.clear()
    if (!state && this._state)
      this._epoch += 1
    this._state = state ? this._mergeSnapshot(state) : undefined
    return this._state
  }

  /**
   * 合并普通权威读取而保留当前连接锚点，领先快照由后续增量安全追赶
   */
  public merge(state: ThreadState): ThreadState {
    this._state = this._mergeSnapshot(state)
    // 快照拥有结构删除权，移除已不存在或已经改变类型的正文锚点
    const parts = new Set(this._state.messages.flatMap(message => message.parts.flatMap(part => (
      part.type === 'text' || part.type === 'reasoning' ? [part.id] : []
    ))))
    for (const id of this._anchors.keys()) {
      if (!parts.has(id))
        this._anchors.delete(id)
    }
    return this._state
  }

  /**
   * 每次真实传输重置只清一次流基线，观察者本地补齐不影响其他消费者
   */
  public resetConnection(connection?: object): void {
    // 新观察者初始化和慢消费校准没有连接身份，普通查询即可补齐其输出
    if (!connection || this._connection === connection)
      return
    this._connection = connection
    this._anchors.clear()
    this._recent.clear()
  }

  /**
   * 返回引用稳定的当前线程快照供运行输出和框架订阅共同读取
   */
  public getSnapshot(): ThreadState | undefined {
    return this._state
  }

  /**
   * 返回读取代次供请求所有者拒绝清空或删除之前启动的迟到响应
   */
  public getEpoch(): number {
    return this._epoch
  }

  /**
   * 解释一条已验证运行事实，只在缺少结构信息时请求外层校准
   */
  public apply(event: RuntimeEvent): ThreadProjectionResult {
    // 1. 会话外层负责固定 Agent 和工作区，这里防止已有线程被其他线程事件替换
    if ((this._state && event.threadId !== this._state.threadId) || this._recent.has(event.id))
      return { state: this._state, refresh: false }

    // 2. 完整线程事件不是断线边界，合并快照但不丢失当前连接的正文锚点
    const thread = readRuntimeEventThreadStatePayload(event)
    if (thread) {
      this.merge(thread)
      return this._result(event)
    }
    if (event.type === 'thread.deleted') {
      // 删除事实即使先于首次快照到达，也必须使删除之前启动的读取和提交失效
      this._state = undefined
      this._anchors.clear()
      this._recent.clear()
      this._epoch += 1
      return this._result(event, true)
    }
    if (!this._state)
      return this._result(event, true)

    // 3. 完整消息和片段按版本合并，锚点保留原事件正文以追赶可能领先的查询快照
    const message = readRuntimeEventMessagePayload(event)
    if (message) {
      for (const part of message.parts) {
        if (part.type === 'text' || part.type === 'reasoning')
          this._anchors.set(part.id, part.text)
      }
      this._replaceMessage(message)
      return this._result(event)
    }
    // 只有已知消息才能确定角色与 Turn；不迁入旧产品猜测 assistant 的占位逻辑
    const owner = this._state.messages.find(item => item.id === event.messageId)
    const part = readRuntimeEventPartPayload(event)
    if (part) {
      if (!owner || owner.turnId !== part.turnId)
        return this._result(event, true)
      if (part.type === 'text' || part.type === 'reasoning')
        this._anchors.set(part.id, part.text)
      this._replacePart(owner, part)
      return this._result(event)
    }

    // 4. 正文和带偏移工具输出各自遵循现有协议，不推断缺失片段类型
    if (event.type === 'message.part.delta')
      return this._applyDelta(event, owner)
    if (event.type === 'message.part.removed') {
      this._anchors.delete(event.partId!)
      if (owner && owner.turnId === event.turnId && owner.parts.some(item => item.id === event.partId)) {
        // 删除不依赖时间戳；最后一个 synthetic part 消失时同时移除临时消息容器
        const parts = owner.parts.filter(item => item.id !== event.partId)
        const messages = parts.length === 0 && owner.kind === 'synthetic'
          ? this._state.messages.filter(item => item.id !== owner.id)
          : this._state.messages.map(item => item.id === owner.id ? { ...owner, parts } : item)
        this._state = { ...this._state, messages }
      }
      return this._result(event, true)
    }

    // Turn、审批、用量、子线程和其他结构变化仍以持久化投影为准，不在 SDK 复制执行状态机
    return this._result(event, true)
  }

  /**
   * 合并有正文锚点的文本或有字符偏移的工具输出
   */
  private _applyDelta(event: RuntimeEvent, owner?: ThreadMessage): ThreadProjectionResult {
    // 校验器保留协议中的 Thread、Turn、消息、片段和工具身份约束
    const delta = readRuntimeEventPartDeltaPayload(event)?.delta
    const current = owner?.parts.find(item => item.id === event.partId)
    if (!delta)
      return this._result(event)
    if (!owner || !current || owner.turnId !== event.turnId || current.turnId !== event.turnId)
      return this._result(event, true)

    if ('text' in delta && (current.type === 'text' || current.type === 'reasoning')) {
      // 查询可能已经包含排队中的增量，缺少锚点时等待完整消息补齐而非反复读取快照
      const anchor = this._anchors.get(current.id)
      if (anchor === undefined)
        return this._result(event)
      const text = anchor + delta.text
      this._anchors.set(current.id, text)
      if (current.text.startsWith(text))
        return this._result(event)
      if (!text.startsWith(current.text))
        return this._result(event, true)
      this._replacePart(owner, { ...current, text })
      return this._result(event)
    }
    if ('output' in delta && current.type === 'tool' && current.toolCallId === event.toolCallId) {
      // 工具输出按所属契约幂等追加，缺口或冲突交回权威快照恢复
      const output = applyRuntimeToolOutputDelta(current.output ?? '', delta)
      if (output === undefined)
        return this._result(event, true)
      if (output !== current.output)
        this._replacePart(owner, { ...current, output })
      return this._result(event)
    }
    return this._result(event, true)
  }

  /**
   * 保护旧回放中的消息和片段版本，并复用语义未变的实体引用
   */
  private _mergeMessage(message: ThreadMessage, previous?: ThreadMessage): ThreadMessage {
    if (!previous)
      return message
    if (previous.updatedAt > message.updatedAt)
      return previous
    if (previous.updatedAt === message.updatedAt && ['completed', 'failed'].includes(previous.status)
      && ['created', 'streaming'].includes(message.status)) {
      return previous
    }
    // 完整消息中的缺失 part 是结构事实；只保护仍存在的片段，不复活已移除内容
    const parts = message.parts.map(part => this._mergePart(part, previous.parts.find(item => item.id === part.id)))
    const next = { ...message, parts }
    return deepEqual(previous, next) ? previous : next
  }

  /**
   * 拒绝更旧或终态回退的片段，保留查询已经获知的正文前缀
   */
  private _mergePart(part: ThreadPart, previous?: ThreadPart): ThreadPart {
    if (!previous)
      return part
    if (previous.updatedAt > part.updatedAt)
      return previous
    if (previous.updatedAt === part.updatedAt && ['completed', 'failed', 'skipped'].includes(previous.status)
      && ['running', 'pending'].includes(part.status)) {
      return previous
    }
    // 正文与工具输出都只保护一致前缀；不同正文仍由通过版本检查的完整事件替换
    if ((part.type === 'text' || part.type === 'reasoning') && previous.type === part.type
      && previous.text.length > part.text.length && previous.text.startsWith(part.text)) {
      part = { ...part, text: previous.text }
    }
    else if (part.type === 'tool' && previous.type === 'tool' && previous.output !== undefined
      && previous.output.length > (part.output?.length ?? 0) && previous.output.startsWith(part.output ?? '')) {
      part = { ...part, output: previous.output }
    }
    return deepEqual(previous, part) ? previous : part
  }

  /**
   * 按权威结构合并完整线程，未变化的消息、片段及领域集合保持原引用
   */
  private _mergeSnapshot(thread: ThreadState): ThreadState {
    // 当前完整投影可能已领先于正在返回的快照和连接回放
    const previous = this._state
    if (!previous || previous.threadId !== thread.threadId)
      return thread
    if (previous.updatedAt > thread.updatedAt)
      return previous
    if (previous.updatedAt === thread.updatedAt && previous.runtime.turnId === thread.runtime.turnId
      && ['completed', 'failed'].includes(previous.runtime.status) && thread.runtime.status === 'running') {
      return previous
    }
    // 快照是结构事实来源，流式正文可领先它；局部结构共享使消费者只重算变化的实体
    const messages = thread.messages.map(message => this._mergeMessage(
      message,
      previous.messages.find(item => item.id === message.id),
    ))
    const next = {
      ...thread,
      messages: messages.length === previous.messages.length
        && messages.every((message, index) => message === previous.messages[index])
        ? previous.messages
        : messages,
      turns: deepEqual(previous.turns, thread.turns) ? previous.turns : thread.turns,
      children: deepEqual(previous.children, thread.children) ? previous.children : thread.children,
      extensions: deepEqual(previous.extensions, thread.extensions) ? previous.extensions : thread.extensions,
      settings: deepEqual(previous.settings, thread.settings) ? previous.settings : thread.settings,
      runtime: deepEqual(previous.runtime, thread.runtime) ? previous.runtime : thread.runtime,
    }
    return deepEqual(previous, next) ? previous : next
  }

  /**
   * 只替换实际变化的消息，其他历史消息继续复用原引用
   */
  private _replaceMessage(input: ThreadMessage) {
    if (!this._state)
      return
    // 以当前消息版本合并输入，只为变化的位置创建新的数组和线程对象
    const index = this._state.messages.findIndex(item => item.id === input.id)
    const previous = this._state.messages[index]
    const message = this._mergeMessage(input, previous)
    if (message === previous)
      return
    const messages = index < 0 ? [...this._state.messages, message] : this._state.messages.with(index, message)
    this._state = { ...this._state, messages }
  }

  /**
   * 按稳定顺序不可变替换单个片段，不降低所属消息的已知时间版本
   */
  private _replacePart(message: ThreadMessage, input: ThreadPart) {
    // 优先在当前片段版本上合并，未变化时连消息容器也不重新创建
    const index = message.parts.findIndex(item => item.id === input.id)
    const previous = message.parts[index]
    const part = this._mergePart(input, previous)
    if (part === previous)
      return
    // 新片段按持久化序号插入，已有片段保持原有位置与其他片段引用
    const parts = index < 0
      ? [...message.parts, part].sort((left, right) => left.seq - right.seq)
      : message.parts.with(index, part)
    const updatedAt = part.updatedAt > message.updatedAt ? part.updatedAt : message.updatedAt
    this._replaceMessage({ ...message, parts, updatedAt })
  }

  /**
   * 返回当前投影，并只确认无需等待外部权威查询的事件
   */
  private _result(event: RuntimeEvent, refresh = false): ThreadProjectionResult {
    if (!refresh) {
      this._recent.add(event.id)
      if (this._recent.size > RECENT_EVENT_LIMIT)
        this._recent.delete(this._recent.values().next().value!)
    }
    return { state: this._state, refresh }
  }
}
