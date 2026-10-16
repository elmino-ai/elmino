import type { ThreadTarget } from '@elmino/api'
import type { ThreadState } from '@elmino/thread'
import type { Client } from '../client/client'
import type { EventChannels } from '../events/channel'
import type { ClientThreadSnapshot } from './types'
import { ORPCError } from '@orpc/client'
import { ThreadProjection } from './projection'

/** 取消本地状态观察，不会取消远端执行 */
export interface ThreadWatchOptions {
  /** 页面卸载或宿主取消时释放当前观察者 */
  signal?: AbortSignal
  /** 连接、快照或调用方投影失败的报告出口 */
  onError?: (error: unknown) => void | Promise<void>
}

/** 内部状态连接通知，不将通道实现暴露成额外公共 API */
interface WatchConnectionOptions extends ThreadWatchOptions {
  /** 校准完成后才标记 connected，不能根据 TCP 建连推测会话已经可用 */
  onStatus?: (status: ClientThreadSnapshot['status']) => void
  /** 权威缺失或删除清除所属会话快照 */
  onMissing?: () => void
}

/**
 * 将共享通道事实交给统一投影，异步消费方仍有独立的背压与释放权
 */
export function watchThread(
  client: Pick<Client, 'rpc'>,
  subscribe: EventChannels['subscribe'],
  target: ThreadTarget,
  listener: (state: ThreadState) => void | Promise<void>,
  options: WatchConnectionOptions = {},
  projection = ThreadProjection.create(),
): () => void {
  // 当前观察只拥有自己的通道引用和在途查询，不接管远端执行
  const controller = new AbortController()
  const scope = { ...target }
  // 成功交付的引用与当前投影分开，消费失败后仍可重新投递相同状态
  let delivered: ThreadState | undefined
  let initialized = false
  let stop: (() => void) | undefined

  /** 停止当前订阅并清理宿主取消信号 */
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

  /** 仅投递实际变化且仍有效的快照，成功后才确认交付位置 */
  const publish = async () => {
    const state = projection.getSnapshot()
    if (!state || state === delivered || controller.signal.aborted)
      return
    await listener(state)
    if (!controller.signal.aborted)
      delivered = state
  }
  /** 重建权威基线，未创建或已删除的线程保持无状态 */
  const refresh = async (connection?: object) => {
    if (controller.signal.aborted)
      return
    // 只有真实传输重置结束旧基线；当前观察者校准不改变其他观察者的流
    projection.resetConnection(connection)
    const epoch = projection.getEpoch()
    const previous = projection.getSnapshot()
    try {
      const state = await client.rpc.thread.get(scope, { signal: controller.signal })
      if (controller.signal.aborted || epoch !== projection.getEpoch())
        return
      projection.merge(state)
      await publish()
      initialized = true
    }
    catch (error) {
      if (controller.signal.aborted || epoch !== projection.getEpoch())
        return
      if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
        // 首次未创建的读取可能晚于另一条创建响应，不能用旧 404 清除新记录
        if (previous !== projection.getSnapshot())
          return
        projection.reset()
        options.onMissing?.()
        initialized = true
        return
      }
      throw error
    }
  }
  try {
    stop = subscribe(scope, {
      /** 订阅成功且首次状态读取完成后才通知可用 */
      onConnected: async () => {
        if (!initialized)
          await refresh()
        if (!controller.signal.aborted)
          options.onStatus?.('connected')
      },
      onReset: refresh,
      /** 流式事实本地合并；结构变化和偏移缺口才请求权威校准 */
      onEvent: async (event) => {
        if (controller.signal.aborted || event.threadId !== scope.threadId)
          return
        const result = projection.apply(event)
        if (!result.state)
          options.onMissing?.()
        if (result.refresh)
          await refresh()
        else
          await publish()
      },
      /** 断线与消费失败报告给所属观察者，其他订阅继续工作 */
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
