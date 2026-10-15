/**
 * 验收说明：使用确定性模型验证本例的真实工具、运行状态与资源退出行为
 * 不加载 .env，也不调用真实模型；可用这些断言对照 src 中说明的成功和失败路径
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sqliteStore } from '@elmino/store-sqlite'
import { expect, onTestFinished, test } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { runControlExample } from '../src/engine/control'

/** 目录不共享用户配置，存储可在示例退出后独立重开 */
async function createDirectory() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-control-test-'))
  await mkdir(path.join(dataDir, 'workspace'))
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }))
  return dataDir
}

test('引导接纳后在工具结束的 Step 边界进入下一次模型请求，并保留原 Turn 身份', async () => {
  const dataDir = await createDirectory()
  const model = createModel([
    response([{ type: 'tool-call', id: 'wait_input', name: 'wait_for_input', args: {} }], 'tool-calls'),
    response([{ type: 'text', text: '收到补充：只回答一句话' }]),
  ])
  const result = await runControlExample({
    dataDir,
    model: model.model,
    control: async ({ engine, request, store }) => {
      expect(model.requests).toHaveLength(1)
      const { agentId, threadId, turnId } = request
      await engine.steer({ agentId, threadId, turnId, store, text: '只回答一句话' })
      expect(model.requests).toHaveLength(1)
      return 'steer'
    },
  })
  expect(result.status).toBe('completed')
  expect(model.requests[1]!.messages.flatMap(message => message.parts)).toContainEqual({ type: 'text', text: '只回答一句话' })
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.list(result.threadId)).toMatchObject([{ id: result.turnId, status: 'completed' }])
    expect(await lease.store.transcript.list(result.threadId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', turnId: result.turnId, parts: expect.arrayContaining([expect.objectContaining({ text: '只回答一句话' })]) })]))
  }
  finally { await lease.release() }
})

test('中断解除等待工具，执行结算为 interrupted，关闭后仍可读取运行事实', async () => {
  const dataDir = await createDirectory()
  const model = createModel([response([{ type: 'tool-call', id: 'wait_input', name: 'wait_for_input', args: {} }], 'tool-calls')])
  const result = await runControlExample({
    dataDir,
    model: model.model,
    control: async ({ engine, request, store }) => {
      const { agentId, threadId, turnId } = request
      expect(await engine.interrupt({ agentId, threadId, turnId, store, reason: '测试中断' })).toBe(true)
      return 'interrupt'
    },
  })
  expect(result.status).toBe('interrupted')
  expect(model.requests).toHaveLength(1)
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.read(result.turnId)).toMatchObject({ status: 'interrupted', interrupt: { kind: 'system', reason: '测试中断', resumableWith: ['message'] } })
  }
  finally { await lease.release() }
})

test('模型未进入等待工具时立即结束示例并释放存储，不能假装接纳控制操作', async () => {
  const dataDir = await createDirectory()
  const model = createModel([response([{ type: 'text', text: '直接完成' }])])
  await expect(runControlExample({
    dataDir,
    model: model.model,
    control: () => { throw new Error('不应打开操作窗口') },
  })).rejects.toThrow('模型未调用等待工具')
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.listAll()).toMatchObject([{ status: 'completed' }])
  }
  finally { await lease.release() }
})

test('引导接纳后模型失败仍报告真实原因，关闭后保存 failed 事实', async () => {
  const dataDir = await createDirectory()
  const model = createModel([
    response([{ type: 'tool-call', id: 'wait_input', name: 'wait_for_input', args: {} }], 'tool-calls'),
    new Error('引导后的模型请求失败'),
  ])
  await expect(runControlExample({
    dataDir,
    model: model.model,
    control: async ({ engine, request, store }) => {
      const { agentId, threadId, turnId } = request
      await engine.steer({ agentId, threadId, turnId, store, text: '继续回答' })
      return 'steer'
    },
  })).rejects.toThrow('引导后的模型请求失败')
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.listAll()).toMatchObject([{ status: 'failed', errorMessage: '引导后的模型请求失败' }])
  }
  finally { await lease.release() }
})

test('宿主操作窗口抛错时关闭等待中的执行，保留原始错误并释放存储', async () => {
  const dataDir = await createDirectory()
  const model = createModel([response([{ type: 'tool-call', id: 'wait_input', name: 'wait_for_input', args: {} }], 'tool-calls')])
  const failure = new Error('终端输入失败')
  await expect(runControlExample({
    dataDir,
    model: model.model,
    control: () => { throw failure },
  })).rejects.toBe(failure)
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.listAll()).toMatchObject([{ status: 'interrupted' }])
  }
  finally { await lease.release() }
})
