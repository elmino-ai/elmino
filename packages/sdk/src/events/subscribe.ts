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

/** 使用公共 oRPC 事件迭代器进行有序消费和有界重连 */
export function subscribeRuntimeEvents(
  connect: (options: EventConnectionOptions) => Promise<AsyncIterable<unknown>>,
  handlers: RuntimeEventSubscribeHandlers,
  retry: ClientRetryOptions = {},
): () => void {
  const initialDelayMs = retry.initialDelayMs ?? 500
  const maxDelayMs = retry.maxDelayMs ?? 10_000
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('事件重连延迟必须是有限正数，且最大延迟不能小于初始延迟')
  }
  const controller = new AbortController()
  let cursor: string | undefined
  let retryMs = initialDelayMs
  let errorReported = false
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
    let timer: ReturnType<typeof setTimeout> | undefined
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
    const events = await connect({ signal: controller.signal, lastEventId: cursor })
    const iterator = events[Symbol.asyncIterator]()
    let closing: Promise<unknown> | undefined
    const close = () => closing ??= Promise.resolve().then(() => iterator.return?.())
    closeCurrent = close
    try {
      while (!controller.signal.aborted) {
        const next = await iterator.next()
        if (next.done || controller.signal.aborted)
          break
        const message = next.value
        const nextCursor = getEventMeta(message)?.id
        if (nextCursor !== undefined && !parseRuntimeEventCursor(nextCursor))
          throw new TypeError('事件流游标无效')
        if (isRuntimeEvent(message)) {
          await handlers.onEvent(message)
          retryMs = initialDelayMs
          errorReported = false
        }
        else {
          const control = RuntimeStreamControlSchema.safeParse(message)
          if (!control.success)
            throw new TypeError('事件流消息未通过协议校验')
          if (control.data.type === 'stream.connected')
            continue
          await handlers.onReset?.()
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

  return () => {
    controller.abort()
    // 某些宿主 Fetch 未把 signal 接到 Response.body，主动 return 仍能释放等待中的 reader
    closeCurrent?.().catch(() => undefined)
  }
}
