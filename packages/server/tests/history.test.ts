import type { ServerAuthorization } from '../src/index'
import { createId } from '@elmino/shared'
import { readThreadInteraction } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { createServerHarness, threadTarget } from './support/server'

test('失败记录在重建 Server 后仍能通过快照、运行历史和转录查询原因与冻结身份', async () => {
  // 模型没有生成助手正文，诊断必须来自持久 Turn 而非流事件缓存
  const harness = await createServerHarness()
  const model = createModel([new Error('历史查询保留模型失败')])
  harness.models.push(model.model)
  const request = harness.request()
  const client = harness.client()
  await client.rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('failed')
  })
  await harness.restart()

  // 三个公开读取入口共用同一份持久事实投影，不重新解析模型
  const target = threadTarget(request)
  const [thread, records, page] = await Promise.all([
    client.rpc.thread.get(target),
    client.rpc.thread.listTurns(target),
    client.rpc.thread.readTranscript(target),
  ])
  const summary = {
    id: request.turnId,
    status: 'failed',
    agentId: request.agentId,
    modelId: model.model.config.id,
    approvalMode: 'fullAccess',
    subagentMode: 'explicitOnly',
    message: expect.stringContaining('历史查询保留模型失败'),
  }
  expect(thread.turns).toEqual([expect.objectContaining(summary)])
  expect(records).toEqual([expect.objectContaining({ ...summary, threadId: request.threadId })])
  expect(page.turns).toEqual([expect.objectContaining(summary)])
  expect(page.nextCursor).toBeNull()
  expect(records[0]).not.toHaveProperty('modelConfig')
  expect(records[0]).not.toHaveProperty('agentSnapshot')
  expect(harness.modelRequests).toHaveLength(1)
})

test('转录按完整 Turn 向前分页，新运行不会进入既有游标的历史页', async () => {
  const harness = await createServerHarness()
  const client = harness.client()
  const target = threadTarget(harness.request())
  // 每轮都有独立输入与回复，跨页不能拆开或混入其他运行的消息
  for (let index = 0; index < 5; index += 1) {
    const request = harness.request({ ...target, input: [{ type: 'text', text: `第 ${index} 轮输入` }] })
    harness.models.push(createModel([response([{ type: 'text', text: `第 ${index} 轮回复` }])]).model)
    await client.rpc.turn.create(request)
    await vi.waitFor(async () => {
      expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
    })
  }
  // 预期次序沿 Store 的创建时间与 ID 共同排序，不依赖随机生成 ID 的字典顺序
  const stored = await harness.stores.primary.store.turns.list(target.threadId)
  const ordered = stored.toSorted((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )).map(turn => turn.id)
  const first = await client.rpc.thread.readTranscript({ ...target, limit: 2 })
  expect(first.turns.map(turn => turn.id)).toEqual(ordered.slice(-2))
  expect(first.nextCursor).toEqual(expect.any(String))

  // 页间新增一轮，原游标仍指向旧历史边界
  const latest = harness.request({ ...target })
  harness.models.push(createModel([response([{ type: 'text', text: '新增运行' }])]).model)
  await client.rpc.turn.create(latest)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(latest.turnId))?.status).toBe('completed')
  })
  const second = await client.rpc.thread.readTranscript({ ...target, limit: 2, cursor: first.nextCursor! })
  const third = await client.rpc.thread.readTranscript({ ...target, limit: 2, cursor: second.nextCursor! })
  expect(second.turns.map(turn => turn.id)).toEqual(ordered.slice(1, 3))
  expect(third.turns.map(turn => turn.id)).toEqual(ordered.slice(0, 1))
  expect(third.nextCursor).toBeNull()
  for (const page of [first, second, third]) {
    const ids = new Set(page.turns.map(turn => turn.id))
    expect(page.messages).toHaveLength(page.turns.length * 2)
    expect(page.messages.every(message => ids.has(message.turnId))).toBe(true)
    expect(page.messages.some(message => message.turnId === latest.turnId)).toBe(false)
  }
  expect((await client.rpc.thread.listTurns(target)).map(turn => turn.id))
    .toEqual([latest.turnId, ...ordered.toReversed()])
})

test('历史查询逐项授权并隔离 Agent、工作区、线程与分页游标', async () => {
  const authorize = vi.fn((_context: ServerAuthorization) => true)
  const harness = await createServerHarness({ authorize })
  const client = harness.client()
  const target = threadTarget(harness.request())
  // 两轮才能生成更早历史游标，其他线程用于验证不能跨线程复用该位置
  for (let index = 0; index < 2; index += 1) {
    const request = harness.request({ ...target })
    harness.models.push(createModel([response([{ type: 'text', text: '授权隔离' }])]).model)
    await client.rpc.turn.create(request)
    await vi.waitFor(async () => {
      expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
    })
  }
  const page = await client.rpc.thread.readTranscript({ ...target, limit: 1 })
  authorize.mockImplementation(context => context.path.join('.') !== 'thread.listTurns')
  const outcomes = await Promise.allSettled([
    client.rpc.thread.listTurns(target),
    client.rpc.thread.readTranscript(target),
  ])
  expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: 'UNAUTHORIZED' } })
  expect(outcomes[1]).toMatchObject({ status: 'fulfilled' })
  authorize.mockReturnValue(true)
  for (const patch of [{ agentId: 'beta' }, { workspaceId: 'secondary' }]) {
    await expect(client.rpc.thread.listTurns({ ...target, ...patch })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.rpc.thread.readTranscript({ ...target, ...patch })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
  const other = harness.request({ threadId: createId('thread') })
  harness.models.push(createModel([response([{ type: 'text', text: '另一会话' }])]).model)
  await client.rpc.turn.create(other)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(other.turnId))?.status).toBe('completed')
  })
  await expect(client.rpc.thread.readTranscript({ ...threadTarget(other), cursor: page.nextCursor! }))
    .rejects
    .toMatchObject({ code: 'BAD_REQUEST' })
  await expect(client.rpc.thread.readTranscript({ ...target, cursor: 'invalid' }))
    .rejects
    .toMatchObject({ code: 'BAD_REQUEST' })
  await expect(client.rpc.thread.readTranscript({ ...target, limit: 51 }))
    .rejects
    .toMatchObject({ code: 'BAD_REQUEST' })
  expect(authorize.mock.calls.some(([context]) => context.path.join('.') === 'thread.listTurns')).toBe(true)
  expect(authorize.mock.calls.some(([context]) => context.path.join('.') === 'thread.readTranscript')).toBe(true)
})

test('审批中断重建后查询原 Turn 交互与冻结权限，不执行工具或读取当前默认值', async () => {
  const execute = vi.fn(() => '只能审批后执行')
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需要审批的工作', schema: z.object({}), approval: 'auto', execute },
  }) })
  const model = createModel([
    response([{ type: 'tool-call', id: 'history_approval', name: 'work', args: {} }], 'tool-calls'),
    new Error('转人工审批'),
  ])
  harness.models.push(model.model)
  const request = harness.request({ approvalMode: 'auto', subagentMode: 'proactive' })
  const client = harness.client()
  await client.rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  })
  const before = await client.rpc.thread.listTurns(threadTarget(request))
  const interrupt = readThreadInteraction(before[0]?.interrupt)
  expect(interrupt?.status).toBe('pending')
  await harness.restart()
  const records = await client.rpc.thread.listTurns(threadTarget(request))
  const page = await client.rpc.thread.readTranscript(threadTarget(request))
  expect(records[0]).toMatchObject({
    id: request.turnId,
    modelId: model.model.config.id,
    approvalMode: 'auto',
    subagentMode: 'proactive',
    interrupt,
    toolCallCount: 1,
    toolResultCount: 0,
  })
  expect(page.turns[0]?.interrupt).toEqual(interrupt)
  expect(execute).not.toHaveBeenCalled()
  expect(harness.modelRequests).toHaveLength(1)
})
