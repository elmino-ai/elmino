import type { ReactTestRenderer } from 'react-test-renderer'
import type { ClientThread } from '../src/thread/types'
import { act, createElement } from 'react'
import { create } from 'react-test-renderer'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { Client } from '../src/client/client'
import { Composer } from '../src/composer'
import { useComposer, useThread } from '../src/react'
import { createComposerThread } from './support/composer'
import { flushUntil, frame, openStream, streamId } from './support/stream'

/** React 使用该宿主标记校验测试中的异步更新边界 */
const environment = globalThis as typeof globalThis & {
  /** 当前测试是否提供 act 调度环境 */
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
/** 保存调用前宿主标记，测试结束后恢复原状态 */
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  if (previousActEnvironment === undefined)
    delete environment.IS_REACT_ACT_ENVIRONMENT
  else
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

test('useThread直接订阅会话，切换和卸载分别释放原观察者', async () => {
  // 两个会话拥有独立观察集合，Hook 不创建当前线程缓存
  const first = createComposerThread()
  const second = createComposerThread()
  // 普通会话方法依赖接收者，验证 Hook 不能把它们当作已绑定回调传出
  const methodThread = {
    /** 仍由原会话持有消息与订阅 */
    source: first.thread,
    /**
     * 通过方法接收者读取原快照
     */
    getSnapshot() {
      return this.source.getSnapshot()
    },
    /**
     * 通过方法接收者借用原订阅
     */
    subscribe(listener: () => void) {
      return this.source.subscribe(listener)
    },
  }
  // 保存真正挂载的渲染器，验证订阅随 React 生命周期释放
  let renderer!: ReactTestRenderer

  /** 只从 Hook 返回的原快照显示连接状态 */
  function ThreadView({ thread }: { /** 当前借用会话 */ thread: ClientThread }) {
    // 原对象拥有状态，组件只读取并渲染
    const snapshot = useThread(thread)
    expect(snapshot).toBe(thread.getSnapshot())
    return createElement('span', null, snapshot.status)
  }

  await act(() => {
    renderer = create(createElement(ThreadView, { thread: methodThread as unknown as ClientThread }))
  })
  expect(first.listeners.size).toBe(1)
  await act(() => {
    first.update({ status: 'reconnecting' })
  })
  expect(renderer.toJSON()).toMatchObject({ children: ['reconnecting'] })
  await act(() => {
    renderer.update(createElement(ThreadView, { thread: second.thread }))
  })
  expect(first.listeners.size).toBe(0)
  expect(second.listeners.size).toBe(1)
  await act(() => {
    renderer.unmount()
  })
  expect(second.listeners.size).toBe(0)
})

test('useComposer复用同一个草稿快照，挂载更新卸载不另建会话状态', async () => {
  // Composer 在组件之外创建，Hook 只借用其订阅和快照
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '原草稿' })
  // 渲染器由本次测试创建并显式卸载
  let renderer!: ReactTestRenderer

  /** 展示已有 Composer 草稿，不使用本地 useState 镜像 */
  function ComposerView() {
    // Hook 必须返回 Composer 当前原始快照
    const snapshot = useComposer(composer)
    expect(snapshot).toBe(composer.getSnapshot())
    return createElement('span', null, snapshot.input.map(part => part.type === 'text' ? part.text : '').join(''))
  }

  await act(() => {
    renderer = create(createElement(ComposerView))
  })
  expect(data.listeners.size).toBe(1)
  await act(() => {
    composer.setInput('更新草稿')
  })
  expect(renderer.toJSON()).toMatchObject({ children: ['更新草稿'] })
  await act(() => {
    renderer.unmount()
  })
  expect(data.listeners.size).toBe(0)
  expect(data.start).not.toHaveBeenCalled()
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '更新草稿' }])
  composer.dispose()
})

test('React挂载真实会话时与异步watch共享状态，最后一位观察者离开才关闭', async () => {
  vi.useFakeTimers()
  // 复用完整会话夹具与真实 SSE 格式，只替换宿主 Fetch，不复制会话实现
  const data = createComposerThread()
  const state = data.state('completed')
  const stream = openStream([frame({ type: 'stream.reset' }, `${streamId}:0`)])
  const requests: Request[] = []
  const client = Client.create({
    baseUrl: 'https://react.example',
    /** 使用真实 Client 与 ThreadClient，仅把网络响应固定为本次领域状态 */
    fetch(input, init) {
      // 统计共享传输，两个消费入口不应打开两条 SSE
      const request = new Request(input, init)
      requests.push(request)
      return Promise.resolve(request.url.endsWith('/events/subscribe')
        ? stream.response
        : Response.json({ json: state }))
    },
  })
  const thread = client.thread({
    agentId: state.agentId,
    workspaceId: state.workspaceId,
    threadId: state.threadId,
  })
  const stopWatching = thread.watch(() => undefined)
  // 渲染器在 finally 中释放，断言失败也不能留下观察或计时器
  let renderer: ReactTestRenderer | undefined

  /** 直接展示真实会话的连接状态，不建立本地状态副本 */
  function Session() {
    // Hook 返回的引用就是生产 ThreadClient 持有的快照
    const snapshot = useThread(thread)
    expect(snapshot).toBe(thread.getSnapshot())
    return createElement('span', null, snapshot.status)
  }

  try {
    // 原 RPC 批处理与会话通知使用受控计时器，先推进它们再读取连接状态
    await vi.advanceTimersByTimeAsync(16)
    await flushUntil(() => thread.getSnapshot().status === 'connected')
    expect(thread.getSnapshot().thread).toEqual(state)
    await act(() => {
      renderer = create(createElement(Session))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16)
      await flushUntil(() => thread.getSnapshot().status === 'connected')
      await vi.advanceTimersByTimeAsync(16)
    })
    expect(renderer!.toJSON()).toMatchObject({ children: ['connected'] })
    expect(requests.filter(request => request.url.endsWith('/events/subscribe'))).toHaveLength(1)
    await act(() => {
      renderer!.unmount()
      renderer = undefined
    })
    // React 退出不能把仍被 watch 观察的真实会话错误标记为 closed
    expect(thread.getSnapshot().status).toBe('connected')
    stopWatching()
    expect(thread.getSnapshot().status).toBe('closed')
    await stream.cancelled
  }
  finally {
    if (renderer) {
      await act(() => {
        renderer!.unmount()
      })
    }
    stopWatching()
    vi.useRealTimers()
  }
})
