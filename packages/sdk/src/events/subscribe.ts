import type { ClientRetryOptions, RuntimeEventSubscribeHandlers } from '../client/types'
import { isRuntimeEvent, parseRuntimeEventCursor, RuntimeStreamControlSchema } from '@elmino/protocol'
import { getEventMeta } from '@orpc/client'

/** 单次连接使用的取消信号与最后确认游标 */
interface EventConnectionOptions {
  /** 订阅释放时取消 HTTP 与当前流读取 */
  signal: AbortSignal
  /** 已成功投影的服务端 SSE id */
  lastEventId?: string
}

/**
 * 使用公共 oRPC 事件迭代器进行有序消费和有界重连
 */
export function subscribeRuntimeEvents(
  connect: (options: EventConnectionOptions) => Promise<AsyncIterable<unknown>>,
  handlers: RuntimeEventSubscribeHandlers,
  retry: ClientRetryOptions = {},
): () => void {
  // 首次连接失败后的等待下限，成功消费事实后重新使用该值
  const initialDelayMs = retry.initialDelayMs ?? 500
  // 限制连续失败的最长等待，避免退避无限增长
  const maxDelayMs = retry.maxDelayMs ?? 10_000
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('事件重连延迟必须是有限正数，且最大延迟不能小于初始延迟')
  }
  // 持有整个独立订阅的取消权，统一停止读取、重连和退避
  const controller = new AbortController()
  // 仅记录成功处理的 SSE 位置，重连从此位置之后继续
  let cursor: string | undefined
  // 当前连续失败阶段的退避时长，成功消费事实后复位
  let retryMs = initialDelayMs
  // 限制连续断线期间的错误通知，恢复消费后允许再次报告
  let errorReported = false
  /** 保存当前迭代器的释放入口，退订时可主动结束等待中的读取 */
  let closeCurrent: (() => Promise<unknown>) | undefined

  /** 错误通知只负责观察，不让同步异常或异步拒绝影响传输生命周期 */
  const reportConnectionError = (error: unknown) => {
    if (errorReported || controller.signal.aborted)
      return
    errorReported = true
    try {
      Promise.resolve(handlers.onError?.(error)).catch(() => undefined)
    }
    catch {
      // 错误观察者不能阻断后续重连
    }
  }

  /** 取消订阅时释放当前退避的计时器和监听 */
  const waitForRetry = () => new Promise<void>((resolve) => {
    // 仅属于本次退避等待的计时器，完成或取消时清除
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 同时清除计时器和取消监听，并结束本次退避等待 */
    const finish = () => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, retryMs)
    controller.signal.addEventListener('abort', finish, { once: true })
    if (controller.signal.aborted)
      finish()
  })

  /** 每次连接拥有一个迭代器；任何退出路径先释放它，再允许下一次连接 */
  const consume = async () => {
    // 带上最后确认游标打开的当前连接，不与下一次重连共用迭代器
    const events = await connect({ signal: controller.signal, lastEventId: cursor })
    // 逐项消费当前连接，处理完成后才推进服务端游标
    const iterator = events[Symbol.asyncIterator]()
    // 复用当前迭代器的关闭承诺，取消和 finally 不重复释放资源
    let closing: Promise<unknown> | undefined
    /** 幂等释放当前迭代器，同时支持主动退订与连接退出 */
    const close = () => closing ??= Promise.resolve().then(() => iterator.return?.())
    closeCurrent = close
    try {
      while (!controller.signal.aborted) {
        // 当前流读取结果，退出或取消后不再投影其内容
        const next = await iterator.next()
        if (next.done || controller.signal.aborted)
          break
        // 当前帧的原始载荷，随后区分领域事实与连接控制
        const message = next.value
        // 当前帧携带的候选游标，校验且处理成功后才确认
        const nextCursor = getEventMeta(message)?.id
        if (nextCursor !== undefined && !parseRuntimeEventCursor(nextCursor))
          throw new TypeError('事件流游标无效')
        if (isRuntimeEvent(message)) {
          await handlers.onEvent(message)
          retryMs = initialDelayMs
          errorReported = false
        }
        else {
          // 校验后的重置或连接就绪指令，失败时进入重连流程
          const control = RuntimeStreamControlSchema.safeParse(message)
          if (!control.success)
            throw new TypeError('事件流消息未通过协议校验')
          if (control.data.type === 'stream.reset')
            await handlers.onReset?.()
          await handlers.onConnected?.()
          if (control.data.type === 'stream.connected')
            continue
        }
        // 已确认事实才更新位置；观察者失败不会越过未处理的消息
        cursor = nextCursor ?? cursor
      }
      if (!controller.signal.aborted)
        throw new Error('事件流连接已结束，正在重连')
    }
    finally {
      try {
        await close()
      }
      finally {
        closeCurrent = undefined
      }
    }
  }

  /** 活跃连接、退避和停止都归属于同一个订阅控制器 */
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        await consume()
      }
      catch (error) {
        reportConnectionError(error)
      }
      if (controller.signal.aborted)
        break
      await waitForRetry()
      retryMs = Math.min(retryMs * 2, maxDelayMs)
    }
  }
  run().catch(reportConnectionError)

  /** 停止整个独立订阅，取消重连与当前读取并主动释放迭代器 */
  return () => {
    controller.abort()
    // 某些宿主 Fetch 未把 signal 接到 Response.body，主动 return 仍能释放等待中的 reader
    closeCurrent?.().catch(() => undefined)
  }
}
