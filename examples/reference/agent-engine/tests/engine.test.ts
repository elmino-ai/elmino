/**
 * 验收说明：使用确定性模型验证本例的真实工具、运行状态与资源退出行为
 * 不加载 .env，也不调用真实模型；可用这些断言对照 src 中说明的成功和失败路径
 */
import type { EngineExampleOptions } from '../src/engine/run'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sqliteStore } from '@elmino/store-sqlite'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { runEngineExample } from '../src/engine/run'

/** 每次验收只使用自己的临时目录，不读取真实模型凭据 */
async function createDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-engine-example-'))
  await mkdir(path.join(root, 'workspace'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

test('同线程两轮保留历史，重建引擎后批准原 Turn，工具只执行一次且存储可重开', async () => {
  const dataDir = await createDirectory()
  const file = path.join(dataDir, 'workspace', 'result.txt')
  const model = createModel([
    response([{ type: 'text', text: '已记住 Hello from elmino' }]),
    response([{ type: 'tool-call', id: 'write_note_call', name: 'write_note', args: { text: 'Hello from elmino' } }], 'tool-calls'),
    response([{ type: 'text', text: '便签已写入' }]),
  ])
  const factory = vi.fn<EngineExampleOptions['model']>((frozenConfig) => {
    if (frozenConfig)
      expect(frozenConfig).toEqual(model.model.config)
    return model.model
  })
  const approve = vi.fn<EngineExampleOptions['approve']>(async (payload) => {
    expect(payload.actionRequests).toMatchObject([{ callId: 'write_note_call', name: 'write_note' }])
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
    return true
  })
  const result = await runEngineExample({ dataDir, model: factory, approve })
  expect(result.status).toBe('completed')
  expect(result.firstTurnId).not.toBe(result.turnId)
  expect(approve).toHaveBeenCalledOnce()
  expect(factory).toHaveBeenCalledTimes(2)
  expect(factory.mock.calls[1]?.[0]).toEqual(model.model.config)
  expect(model.requests).toHaveLength(3)
  expect(model.requests[1]!.messages.flatMap(message => message.parts)).toContainEqual({ type: 'text', text: '已记住 Hello from elmino' })
  expect(model.requests[2]!.messages.flatMap(message => message.parts)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'tool-result', callId: 'write_note_call' }),
  ]))
  expect(await readFile(file, 'utf8')).toBe('Hello from elmino')
  const lease = await sqliteStore({ dataDir })()
  try {
    const turns = await lease.store.turns.list(result.threadId)
    expect(turns).toHaveLength(2)
    expect(turns.every(turn => turn.status === 'completed')).toBe(true)
    expect((await lease.store.toolCalls.list({ turnId: result.turnId })).map(call => call.status)).toEqual(['completed'])
  }
  finally { await lease.release() }
})

test('用户暂不批准时保留审批事实，不执行工具或发起恢复采样', async () => {
  const dataDir = await createDirectory()
  const model = createModel([
    response([{ type: 'text', text: '已记住' }]),
    response([{ type: 'tool-call', id: 'pending_write', name: 'write_note', args: { text: 'Hello from elmino' } }], 'tool-calls'),
  ])
  const result = await runEngineExample({ dataDir, model: () => model.model, approve: () => false })
  expect(result.status).toBe('interrupted')
  expect(model.requests).toHaveLength(2)
  await expect(access(path.join(dataDir, 'workspace', 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  const lease = await sqliteStore({ dataDir })()
  try {
    const turn = await lease.store.turns.read(result.turnId)
    expect(turn).toMatchObject({ status: 'interrupted', interrupt: { status: 'pending', interaction: 'tool_approval' } })
    expect((await lease.store.toolCalls.list({ turnId: result.turnId })).every(call => call.status !== 'completed')).toBe(true)
  }
  finally { await lease.release() }
})

test('模型执行失败后报告原因并释放存储，不进入第二轮或审批', async () => {
  const dataDir = await createDirectory()
  const model = createModel([new Error('示例模型不可用')])
  const approve = vi.fn(() => true)
  await expect(runEngineExample({ dataDir, model: () => model.model, approve })).rejects.toThrow('示例模型不可用')
  expect(approve).not.toHaveBeenCalled()
  const lease = await sqliteStore({ dataDir })()
  try {
    expect(await lease.store.turns.listAll()).toMatchObject([{ status: 'failed', errorMessage: '示例模型不可用' }])
  }
  finally { await lease.release() }
})
