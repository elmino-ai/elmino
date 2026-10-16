import type { ThreadState } from '@elmino/thread'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../engine/tests/support/model'
import { createGatedModel, createServerHarness } from './support/server'

/** 固定一次会话身份后，普通调用无需触碰原始 RPC 或反复传 Agent / 工作区 */
test('ClientThread 续聊沿用线程，目录查询与历史读取均通过便捷入口', async () => {
  const harness = await createServerHarness()
  const first = createModel([response([{ type: 'text', text: '第一轮' }])])
  const second = createModel([response([{ type: 'text', text: '第二轮' }])])
  harness.models.push(first.model, second.model)
  const client = harness.client()
  const thread = client.thread({ agentId: 'alpha', workspaceId: 'primary' })
  expect(thread.threadId).toMatch(/^thread_/u)
  expect(harness.modelRequests).toEqual([])
  expect(await client.health()).toEqual({ status: 'ok' })
  expect(await client.listAgents()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'alpha' }),
    expect.objectContaining({ id: 'beta' }),
  ]))
  expect(harness.modelRequests).toEqual([])

  const initial = await thread.run('第一条', { signal: AbortSignal.timeout(5_000) })
  const output: string[] = []
  const continued = await thread.run('继续', {
    signal: AbortSignal.timeout(5_000),
    onText: (text) => { output.push(text) },
  })
  expect(initial).toMatchObject({ agentId: 'alpha', workspaceId: 'primary', threadId: thread.threadId, status: 'completed' })
  expect(continued.threadId).toBe(initial.threadId)
  expect(continued.turnId).not.toBe(initial.turnId)
  expect(continued.thread.turns.map(turn => turn.id)).toEqual([initial.turnId, continued.turnId])
  expect(output.join('')).toBe('第二轮')
  expect(await thread.get()).toEqual(continued.thread)
  expect((await client.listThreads({ agentId: 'alpha', workspaceId: 'primary' })).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ threadId: thread.threadId }),
  ]))
  expect(second.requests[0]?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', parts: [{ type: 'text', text: '第一轮' }] }),
  ]))
}, 10_000)

test('start 同步提供准确身份，立即请求中断会先等待接纳并停止原 Turn', async () => {
  const harness = await createServerHarness()
  const model = createGatedModel('中断后不应输出')
  harness.models.push(model.model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const task = thread.start('执行长任务', { signal: AbortSignal.timeout(5_000) })
  expect(task).toMatchObject({ agentId: thread.agentId, workspaceId: thread.workspaceId, threadId: thread.threadId })
  expect(task.turnId).toMatch(/^turn_/u)
  const stopped = task.interrupt('用户停止原任务')
  const state = await stopped
  const result = await task.completed
  expect(state.turns.find(turn => turn.id === task.turnId)?.status).toBe('interrupted')
  expect(result).toMatchObject({ threadId: thread.threadId, turnId: task.turnId, status: 'interrupted' })
  expect(result.interaction).toBeUndefined()
  expect(await harness.stores.primary.store.turns.read(task.turnId)).toMatchObject({
    status: 'interrupted',
  })
  expect(harness.events.filter(event => event.type === 'turn.interrupted' && event.turnId === task.turnId)).toHaveLength(1)
}, 10_000)

test('steer 在同一轮追加要求，模型在下一执行边界读到用户引导', async () => {
  const harness = await createServerHarness()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  onTestFinished(() => release.resolve())
  const model = createModel([
    async () => {
      entered.resolve()
      await release.promise
      return response([{ type: 'text', text: '初步结果' }])
    },
    response([{ type: 'text', text: '已按追加要求完成' }]),
  ])
  harness.models.push(model.model)
  const thread = harness.client().thread({ agentId: 'alpha', workspaceId: 'primary' })
  const task = thread.start('检查项目', { signal: AbortSignal.timeout(5_000) })
  await task.accepted
  await entered.promise
  const accepted = await task.steer('重点检查存储模块')
  expect(accepted.turnId).toBe(task.turnId)
  release.resolve()
  const result = await task.completed
  expect(result.status).toBe('completed')
  expect(result.thread.turns).toHaveLength(1)
  expect(model.requests).toHaveLength(2)
  expect(model.requests[1]?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: '重点检查存储模块' }] }),
  ]))
  expect(result.thread.messages).toContainEqual(expect.objectContaining({
    turnId: task.turnId,
    role: 'user',
    parts: [expect.objectContaining({ type: 'text', text: '重点检查存储模块' })],
  }))
}, 10_000)

test('detach 只释放本地等待，attach 找回既有运行且不重复创建或调用模型', async () => {
  const harness = await createServerHarness()
  const model = createGatedModel('重新连接后完成')
  harness.models.push(model.model)
  const client = harness.client()
  const thread = client.thread({ agentId: 'alpha', workspaceId: 'primary' })
  const task = thread.start('稍后重新观察', { signal: AbortSignal.timeout(5_000) })
  await task.accepted
  await model.entered
  const reason = new Error('用户切走页面')
  const detached = expect(task.completed).rejects.toBe(reason)
  task.detach(reason)
  await detached
  expect(model.signal?.aborted).toBe(false)
  expect((await thread.get()).runtime.status).toBe('running')
  const output: string[] = []
  const attached = client.thread({ agentId: thread.agentId, workspaceId: thread.workspaceId, threadId: thread.threadId })
    .attach(task.turnId, { signal: AbortSignal.timeout(5_000), onText: (text) => { output.push(text) } })
  await attached.accepted
  model.release()
  const result = await attached.completed
  expect(result).toMatchObject({ turnId: task.turnId, threadId: task.threadId, status: 'completed' })
  expect(output.join('')).toBe('重新连接后完成')
  expect(model.requests).toHaveLength(1)
  expect(harness.modelRequests).toHaveLength(1)
  expect(await harness.stores.primary.store.turns.list(task.threadId)).toHaveLength(1)
}, 10_000)

test('watch 与并发 run 复用单个工作区事件连接，单个输出回调失败不影响其他任务', async () => {
  const harness = await createServerHarness()
  harness.models.push(createModel([response([{ type: 'text', text: '建立持久会话' }])]).model)
  const client = harness.client()
  const thread = client.thread({ agentId: 'alpha', workspaceId: 'primary' })
  await thread.run('初始化', { signal: AbortSignal.timeout(5_000) })
  const previous = harness.requests.filter(request => new URL(request.url).pathname.endsWith('/events/subscribe')).length
  const observed: ThreadState[] = []
  const stop = thread.watch((state) => {
    observed.push(state)
  }, { signal: AbortSignal.timeout(5_000) })
  onTestFinished(stop)
  await vi.waitFor(() => expect(observed.length).toBeGreaterThan(0))
  const gate = createGatedModel('正常任务输出')
  const failing = createModel([response([{ type: 'text', text: '失败观察者的远端仍正常完成' }])])
  harness.models.push(gate.model, failing.model)
  const healthy = thread.start('继续', { signal: AbortSignal.timeout(5_000) })
  await healthy.accepted
  await gate.entered
  const failure = new Error('单个页面渲染失败')
  const broken = client.thread({ agentId: 'alpha', workspaceId: 'primary' }).start('另一个任务', {
    signal: AbortSignal.timeout(5_000),
    onText: () => {
      throw failure
    },
  })
  await expect(broken.completed).rejects.toBe(failure)
  expect(gate.signal?.aborted).toBe(false)
  const subscriptions = harness.requests.filter(request => new URL(request.url).pathname.endsWith('/events/subscribe')).slice(previous)
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]?.signal.aborted).toBe(false)
  gate.release()
  expect((await healthy.completed).status).toBe('completed')
  await vi.waitFor(() => expect(observed.at(-1)?.turns.find(turn => turn.id === healthy.turnId)?.status).toBe('completed'))
  expect(subscriptions[0]?.signal.aborted).toBe(false)
  stop()
  await vi.waitFor(() => expect(subscriptions[0]?.signal.aborted).toBe(true))
  expect(failing.requests).toHaveLength(1)
  expect(harness.modelRequests).toHaveLength(3)
}, 10_000)
