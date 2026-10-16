import type { RuntimeEventSubscribeInput } from '@elmino/api'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { Client } from '../client/client'
import type { ClientRetryOptions, RuntimeEventSubscribeHandlers } from '../client/types'

/** 一个观察者最多保留的排队通知；慢观察者通过快照校准，不拖住工作区传输 */
const MAX_PENDING_DELIVERIES = 128

/** 单个观察者按顺序处理的连接控制或领域事实 */
type Delivery = { type: 'reset', connection?: object } | { type: 'connected' } | { type: 'event', event: RuntimeEvent }

/** 通道内部区分传输重置与单观察者校准，原始订阅保持公开无参数契约 */
export interface ChannelSubscribeHandlers extends RuntimeEventSubscribeHandlers {
  /** 同一次传输重置共用身份；本地初始化、过载和重试不传连接身份 */
  onReset?: (connection?: object) => void | Promise<void>
}

/** 独立的有界处理队列，允许观察回调等待同一工作区内的其他任务 */
interface Observer {
  /** 只过滤当前观察者，不缩小共享服务端连接的范围 */
  threadId?: string
  /** 调用方提供的事实与连接处理器 */
  handlers: ChannelSubscribeHandlers
  /** 已释放的观察者不能接收排队或迟到的回调 */
  active: boolean
  /** 失败后需要先重建快照，再消费后续实时事实 */
  dirty: boolean
  /** 同一观察者始终只有一个消费协程 */
  running: boolean
  /** 最多 128 个排队通知；超量时合并为权威快照重建 */
  queue: Delivery[]
  /** 每个观察者至多一枚重试计时器，释放或底层断线时立即清除 */
  timer?: ReturnType<typeof setTimeout>
  /** 当前快照重试等待时间，成功校准后恢复初始值 */
  retryMs: number
}

/** 同一个 Client 的一个工作区只持有一条底层事件连接 */
interface EventChannel {
  /** 由该工作区连接服务的独立观察者 */
  observers: Set<Observer>
  /** 已完成回放与重置，可以接收新任务 */
  connected: boolean
  /** 最后一个观察者释放时关闭底层连接 */
  stop: () => void
}

/** 共享连接复用原始订阅契约；底层 Client.subscribe 仍保留独立连接语义 */
export interface EventChannels {
  /** 观察指定工作区，可选地只接收单个线程的事件 */
  subscribe: (input: RuntimeEventSubscribeInput, handlers: ChannelSubscribeHandlers) => () => void
}

/**
 * 工作区传输与观察者处理独立；过载时恢复权威状态，不无限缓存事实
 */
export function createEventChannels(subscribe: Client['subscribe'], retry: ClientRetryOptions = {}): EventChannels {
  // 观察者首次校准失败后的等待下限，成功重建快照后复位
  const initialDelayMs = retry.initialDelayMs ?? 500
  // 限制单个观察者的最长重试间隔，不影响其他观察者
  const maxDelayMs = retry.maxDelayMs ?? 10_000
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('事件重连延迟必须是有限正数，且最大延迟不能小于初始延迟')
  }
  // 仅保存有活跃观察者的工作区通道，最后释放时移除
  const channels = new Map<string, EventChannel>()

  /** 隔离单个观察者的错误报告，报告失败不影响同工作区的其他调用 */
  const report = async (observer: Observer, error: unknown) => {
    if (!observer.active)
      return
    try {
      await observer.handlers.onError?.(error)
    }
    catch {
      // 一个观察者的错误报告失败不能影响同一连接上的其他执行
    }
  }

  /** 释放观察者唯一的退避计时器，不改变底层连接所有权 */
  const clearRetry = (observer: Observer) => {
    clearTimeout(observer.timer)
    observer.timer = undefined
  }

  /** 丢弃无法继续可靠投影的队列，安排快照重建与必要的就绪通知 */
  const calibrate = (observer: Observer, connected: boolean, connection?: object) => {
    clearRetry(observer)
    // 过载也不能覆盖尚未消费的传输重置，否则旧正文锚点会越过新连接
    const pending = observer.queue.find(item => item.type === 'reset' && item.connection)
    observer.queue = [{ type: 'reset', connection: connection ?? (pending?.type === 'reset' ? pending.connection : undefined) }]
    if (connected)
      observer.queue.push({ type: 'connected' })
    observer.dirty = false
  }

  /** 为在线通道中的失败观察者安排唯一退避重试，离线交给底层重连 */
  const scheduleRetry = (observer: Observer, channel: EventChannel, restart: () => Promise<void>) => {
    if (!observer.active || !observer.dirty || observer.timer !== undefined || !channel.connected)
      return
    observer.timer = setTimeout(() => {
      observer.timer = undefined
      if (!observer.active || !channel.connected)
        return
      calibrate(observer, true)
      restart().catch(error => report(observer, error))
    }, observer.retryMs)
    observer.retryMs = Math.min(observer.retryMs * 2, maxDelayMs)
  }

  /** 独立串行消费观察者通知，慢回调不会阻塞共享传输或其他任务 */
  const drain = async (observer: Observer, channel: EventChannel) => {
    if (observer.running)
      return
    observer.running = true
    try {
      while (observer.active && observer.queue.length > 0) {
        // 从当前观察者有界队列取出的下一项通知
        const delivery = observer.queue.shift()!
        try {
          if (delivery.type === 'reset') {
            await observer.handlers.onReset?.(delivery.connection)
            observer.retryMs = initialDelayMs
          }
          else if (delivery.type === 'connected') {
            // 排队期间可能已离线；成功校准也不能替代底层连接就绪
            if (channel.connected)
              await observer.handlers.onConnected?.()
          }
          else {
            await observer.handlers.onEvent(delivery.event)
          }
        }
        catch (error) {
          observer.queue = []
          observer.dirty = true
          await report(observer, error)
          if (!observer.active)
            break
          if (observer.dirty) {
            // 即使远端已完成且没有后续事件，也必须自主重试快照，不能永久等待
            scheduleRetry(observer, channel, () => drain(observer, channel))
            break
          }
          // 错误报告期间收到真实重连控制时，直接处理它已安排的校准
        }
      }
    }
    finally {
      observer.running = false
    }
  }

  /** 按观察者入队，过载或失败时改由权威快照覆盖丢弃的事实 */
  const enqueue = (observer: Observer, channel: EventChannel, delivery: Delivery) => {
    if (!observer.active)
      return
    if (observer.dirty && delivery.type !== 'reset') {
      // 退避期间不为每条新事实再次发起查询；下一次快照覆盖这些事实
      scheduleRetry(observer, channel, () => drain(observer, channel))
      return
    }
    if (delivery.type === 'reset' || observer.dirty || observer.queue.length >= MAX_PENDING_DELIVERIES) {
      // 快照会包含丢弃的排队事实；校准后才允许消费后续增量
      calibrate(observer, delivery.type === 'reset' ? false : channel.connected, delivery.type === 'reset' ? delivery.connection : undefined)
    }
    else {
      observer.queue.push(delivery)
    }
    // 不能等待观察者，否则 listener 内 await 同工作区 run/approve 会锁住自身事件来源
    drain(observer, channel).catch(error => report(observer, error))
  }

  /** 复用工作区通道并登记观察者，返回只释放当前观察者的入口 */
  const attach = (input: RuntimeEventSubscribeInput, handlers: ChannelSubscribeHandlers) => {
    // Agent 与工作区共同组成连接身份，线程过滤留在本地观察者
    const key = JSON.stringify([input.agentId, input.workspaceId])
    // 当前调用独占的投影队列、重试状态和释放标记
    const observer: Observer = { threadId: input.threadId, handlers, active: true, dirty: false, running: false, queue: [], retryMs: initialDelayMs }
    // 当前工作区已存在的通道，没有时由本次调用创建
    let channel = channels.get(key)
    if (!channel) {
      channel = { observers: new Set([observer]), connected: false, stop: () => undefined }
      channels.set(key, channel)
      // 闭包固定本次使用的通道，异步回调和释放不重新查找或更换连接
      const current = channel
      try {
        current.stop = subscribe({ agentId: input.agentId, workspaceId: input.workspaceId }, {
          /**
           * 仅分发匹配线程的事实，各观察者独立处理，不阻塞共享连接读取
           */
          onEvent(event) {
            // 遍历当前通道仍持有的观察者，只操作其自有队列或重试资源
            for (const item of current.observers) {
              if (!item.threadId || item.threadId === event.threadId)
                enqueue(item, current, { type: 'event', event })
            }
          },
          /**
           * 标记底层连接正在校准，并让每个观察者重建自己的权威状态
           */
          onReset() {
            current.connected = false
            // 所有观察者共享传输边界；慢观察者不能重复清除其他观察者的新锚点
            const connection = {}
            // 遍历当前通道仍持有的观察者，只操作其自有队列或重试资源
            for (const item of current.observers)
              enqueue(item, current, { type: 'reset', connection })
          },
          /**
           * 记录底层连接已就绪，观察者仍须先完成各自排队的校准
           */
          onConnected() {
            current.connected = true
            // 遍历当前通道仍持有的观察者，只操作其自有队列或重试资源
            for (const item of current.observers)
              enqueue(item, current, { type: 'connected' })
          },
          /**
           * 断线时释放观察者重试计时器，连接恢复仍由底层独立订阅负责
           */
          onError(error) {
            current.connected = false
            // 遍历当前通道仍持有的观察者，只操作其自有队列或重试资源
            for (const item of current.observers) {
              clearRetry(item)
              report(item, error).catch(() => undefined)
            }
          },
        })
      }
      catch (error) {
        channels.delete(key)
        observer.active = false
        throw error
      }
    }
    else {
      channel.observers.add(observer)
      if (channel.connected) {
        // 新观察者没有此前事实，先建立自身快照，再通知可接纳任务
        enqueue(observer, channel, { type: 'reset' })
        enqueue(observer, channel, { type: 'connected' })
      }
    }
    // 闭包固定本次使用的通道，异步回调和释放不重新查找或更换连接
    const current = channel
    /** 幂等释放当前观察者，只有最后一个观察者离开才关闭共享连接 */
    return () => {
      if (!observer.active)
        return
      observer.active = false
      observer.queue = []
      clearRetry(observer)
      current.observers.delete(observer)
      if (current.observers.size === 0) {
        channels.delete(key)
        current.stop()
      }
    }
  }

  return { subscribe: attach }
}
