import type { RuntimeStreamMessage } from '@elmino/protocol'
import type { RuntimeEvent } from '@elmino/thread/events'
import { Buffer } from 'node:buffer'
import { createRuntimeEventCursor, parseRuntimeEventCursor, serializeRuntimeEvent } from '@elmino/protocol'
import { createId } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 与传输库无关的事件帧，游标交由 HTTP 或 SSE 适配层传递 */
export interface RuntimeEventFrame {
  /** 当前服务进程中已经消费的全局位置 */
  cursor: string
  /** 领域事实或流控制消息 */
  message: RuntimeStreamMessage
}

/** 当前进程共享的有界重放窗口配置 */
export interface RuntimeEventHubOptions {
  /** 保留事件的最大 UTF-8 JSON 字节数，零表示不保留重放 */
  maxBytes?: number
  /** 测试或宿主明确分配的流身份，重启后必须更换 */
  streamId?: string
}

/** 一次订阅固定的领域事件过滤条件，控制帧始终使用全局游标 */
export interface RuntimeEventHubFilter {
  /** 只输出此线程的领域事件，其他线程仍推进订阅的全局位置 */
  threadId?: string
}

/** 保留窗口中的不可被调用方持有的事件快照 */
interface ReplayFrame extends RuntimeEventFrame {
  /** 与发布时同一次序列化对应的确定性字节数 */
  byteLength: number
  /** 重放窗口只保留领域事件 */
  message: RuntimeEvent
}

/** -------------------- 常量 -------------------- */
/** 默认保留八 MiB 领域事件 */
const REPLAY_MAX_BYTES = 8 * 1024 * 1024

/** -------------------- 核心类 -------------------- */
/**
 * 单个 Server 进程的有界事件流，重放失效由客户端重新读取持久化快照
 */
export class RuntimeEventHub {
  /** 当前进程的流身份 */
  private readonly _streamId: string
  /** 重放窗口的最大字节数 */
  private readonly _maxBytes: number
  /** 等待新事件或关闭通知的订阅方 */
  private readonly _subscribers = new Set<() => void>()
  /** 按全局序号保存的连续重放窗口 */
  private readonly _frames = new Map<number, ReplayFrame>()
  /** 当前保留的序列化字节数 */
  private _byteLength = 0
  /** 最后发布的全局事件序号 */
  private _seq = 0
  /** 关闭后不能继续发布或创建活跃订阅 */
  private _closed = false

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建进程内的运行事件订阅中心
   */
  public static create(options: RuntimeEventHubOptions = {}) {
    return new RuntimeEventHub(options)
  }

  /**
   * 校验容量与流身份，避免生成客户端无法恢复的游标
   */
  private constructor(options: RuntimeEventHubOptions) {
    this._streamId = options.streamId ?? createId('stream')
    this._maxBytes = options.maxBytes ?? REPLAY_MAX_BYTES
    if (!Number.isSafeInteger(this._maxBytes) || this._maxBytes < 0)
      throw new RangeError('事件重放容量必须是非负安全整数字节数')
    createRuntimeEventCursor({ streamId: this._streamId, sequence: 0 })
  }

  /**
   * 以同一次序列化固定快照与字节预算，失败的事件不占用全局序号
   */
  public publish(event: RuntimeEvent) {
    if (this._closed)
      throw new Error('运行事件 Hub 已关闭')
    const serialized = serializeRuntimeEvent(event)
    // 序列化已完成领域校验；使用同一 JSON 创建快照，省略可选 undefined 字段。
    const message = JSON.parse(serialized) as RuntimeEvent
    const seq = this._seq + 1
    const frame: ReplayFrame = {
      cursor: createRuntimeEventCursor({ streamId: this._streamId, sequence: seq }),
      message,
      byteLength: Buffer.byteLength(serialized),
    }

    this._seq = seq
    this._frames.set(seq, frame)
    this._byteLength += frame.byteLength
    this._evictOverflow()
    for (const wake of this._subscribers)
      wake()
  }

  /**
   * 先重放合法游标之后的事件再确认连接，过滤只影响领域帧而不改变全局位置
   */
  public async* subscribe(
    lastEventId?: string,
    signal?: AbortSignal,
    filter?: RuntimeEventHubFilter,
  ): AsyncGenerator<RuntimeEventFrame, void, unknown> {
    if (this._closed || signal?.aborted)
      return
    const threadId = filter?.threadId
    let seq = this._resolveSequence(lastEventId)

    if (seq === undefined) {
      seq = this._seq
      yield this._controlFrame('stream.reset', seq)
    }
    else {
      const replayUntil = this._seq
      while (seq < replayUntil && !this._closed && !signal?.aborted) {
        const frame = this._frames.get(seq + 1)
        if (!frame)
          throw new Error('运行事件订阅落后于回放窗口')
        seq++
        if (threadId === undefined || frame.message.threadId === threadId)
          yield { cursor: frame.cursor, message: structuredClone(frame.message) }
      }
      if (this._closed || signal?.aborted)
        return
      yield this._controlFrame('stream.connected', seq)
    }

    while (!this._closed && !signal?.aborted) {
      const frame = this._frames.get(seq + 1)
      if (frame) {
        seq++
        if (threadId === undefined || frame.message.threadId === threadId)
          yield { cursor: frame.cursor, message: structuredClone(frame.message) }
        continue
      }
      if (seq < this._seq)
        throw new Error('运行事件订阅落后于回放窗口')
      await this._waitForEvent(seq, signal)
    }
  }

  /**
   * 结束全部等待中的订阅并释放重放内存，重复关闭不产生额外动作
   */
  public close() {
    if (this._closed)
      return
    this._closed = true
    this._frames.clear()
    this._byteLength = 0
    for (const wake of this._subscribers)
      wake()
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 等待事件、请求取消或 Hub 关闭，任何出口都会移除取消监听
   */
  private _waitForEvent(seq: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      /** 释放本次等待持有的全部监听 */
      const finish = () => {
        this._subscribers.delete(finish)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      this._subscribers.add(finish)
      signal?.addEventListener('abort', finish, { once: true })
      if (this._closed || signal?.aborted || this._seq > seq)
        finish()
    })
  }

  /**
   * 校验当前进程与保留窗口，允许从窗口首事件之前的紧邻位置恢复
   */
  private _resolveSequence(cursor?: string) {
    const parsed = parseRuntimeEventCursor(cursor)
    const firstSeq = this._frames.keys().next().value ?? this._seq + 1
    if (!parsed || parsed.streamId !== this._streamId
      || parsed.sequence > this._seq || parsed.sequence < firstSeq - 1) {
      return undefined
    }
    return parsed.sequence
  }

  /**
   * 控制消息只携带全局位置，不包含其他线程的事实载荷
   */
  private _controlFrame(type: 'stream.connected' | 'stream.reset', seq: number): RuntimeEventFrame {
    return {
      cursor: createRuntimeEventCursor({ streamId: this._streamId, sequence: seq }),
      message: { type },
    }
  }

  /**
   * 按 UTF-8 字节预算淘汰最老事件，单条超大事件也不突破容量
   */
  private _evictOverflow() {
    while (this._byteLength > this._maxBytes) {
      const oldest = this._frames.entries().next().value
      if (!oldest)
        break
      const [seq, frame] = oldest
      this._frames.delete(seq)
      this._byteLength -= frame.byteLength
    }
  }
}
