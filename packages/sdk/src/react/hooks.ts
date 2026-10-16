import type { Composer } from '../composer/composer'
import type { ComposerSnapshot } from '../composer/types'
import type { ClientThread, ClientThreadSnapshot } from '../thread/types'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * 订阅既有会话对象，消息与连接状态不在 React 中复制
 */
export function useThread(thread: ClientThread): ClientThreadSnapshot {
  // 原方法保留会话接收者，绑定回调在同一对象的多次渲染中保持稳定
  return useSyncExternalStore(
    useCallback((listener: () => void) => thread.subscribe(listener), [thread]),
    useCallback(() => thread.getSnapshot(), [thread]),
    useCallback(() => thread.getSnapshot(), [thread]),
  )
}

/**
 * 订阅既有 Composer，草稿和队列不在 Hook 中重新构造
 */
export function useComposer(composer: Composer): ComposerSnapshot {
  return useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot)
}
