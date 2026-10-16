import type { ServerAuthorization } from '../src/index'
import { createId } from '@elmino/shared'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createModel, response } from '../../engine/tests/support/model'
import { createServerHarness, threadTarget } from './support/server'

/** 待审批取消经过真实 RPC、Core、Engine 与事务存储，不靠拒绝工具模拟 */
test('重启后取消原审批 Turn，工具只结算一次，旧审批不能恢复任务', async () => {
  const execute = vi.fn(({ value }: { value: string }) => value)
  const harness = await createServerHarness({ tools: defineTools({
    work: { description: '需要审批的工作', schema: z.object({ value: z.string() }), approval: 'auto', execute },
  }) })
  harness.models.push(createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'pending' } }], 'tool-calls'),
    new Error('需要人工审批'),
  ]).model)
  const request = harness.request({ approvalMode: 'auto' })
  const client = harness.client()
  await client.rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  })
  const turn = await harness.stores.primary.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(turn?.interrupt))!
  const target = { ...threadTarget(request), turnId: request.turnId, interruptId: interrupt.id }
  await harness.restart()
  const original = await harness.stores.primary.store.turns.read(request.turnId)
  await expect(client.rpc.turn.cancel({ ...target, interruptId: createId('interrupt') })).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  expect(await harness.stores.primary.store.turns.read(request.turnId)).toEqual(original)
  const state = await client.rpc.turn.cancel({ ...target, reason: '用户取消整个任务' })
  const store = harness.stores.primary.store
  expect(state.turns.find(turn => turn.id === request.turnId)?.status).toBe('cancelled')
  expect(state.runtime.interrupt).toBeUndefined()
  expect(await store.turns.read(request.turnId)).toMatchObject({
    status: 'cancelled',
    errorMessage: '用户取消整个任务',
    interrupt: null,
  })
  const tools = await store.toolCalls.list({ turnId: request.turnId })
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({ status: 'failed', errorMessage: '用户取消整个任务' })
  expect(tools[0]?.resultPartId).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
  expect(harness.modelRequests).toHaveLength(1)
  expect(harness.events.filter(event => event.type === 'turn.cancelled' && event.turnId === request.turnId))
    .toHaveLength(1)
  const resume = { ...target, response: { decisions: [{ type: 'approve', callId: 'native_work' }] } }
  await expect(client.rpc.turn.resume(resume)).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(client.rpc.turn.cancel(target)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await store.toolCalls.list({ turnId: request.turnId })).toEqual(tools)
  expect(await store.turns.list(request.threadId)).toHaveLength(1)
})

test('并发取消只接受一次，并逐项执行授权检查', async () => {
  const authorize = vi.fn((_context: ServerAuthorization) => true)
  const harness = await createServerHarness({ authorize, tools: defineTools({
    work: { description: '需审批的工具', schema: z.object({}), approval: 'auto', execute: () => '完成' },
  }) })
  harness.models.push(createModel([
    response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    new Error('需要人工审批'),
  ]).model)
  const request = harness.request({ approvalMode: 'auto' })
  const client = harness.client()
  await client.rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  })
  const turn = await harness.stores.primary.store.turns.read(request.turnId)
  const interrupt = readThreadInteraction(readThreadInterrupt(turn?.interrupt))!
  const target = { ...threadTarget(request), turnId: request.turnId, interruptId: interrupt.id }
  authorize.mockReturnValueOnce(false)
  await expect(client.rpc.turn.cancel(target)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  const results = await Promise.allSettled([client.rpc.turn.cancel(target), client.rpc.turn.cancel(target)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
  expect(authorize.mock.calls.some(([context]) => context.path.join('.') === 'turn.cancel')).toBe(true)
})
