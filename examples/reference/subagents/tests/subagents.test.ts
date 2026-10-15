/**
 * 验收说明：使用确定性模型验证本例的真实工具、运行状态与资源退出行为
 * 不加载 .env，也不调用真实模型；可用这些断言对照 src 中说明的成功和失败路径
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'
import { expect, onTestFinished, test } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { coordinator } from '../src/agent/agent'

test.each([false, true])('两个工具分别派生独立子任务，子任务失败=%s 也把真实状态交给父模型', async (fails) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-subagents-test-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }))
  const model = createModel([
    response([
      { type: 'tool-call', id: 'delegate_a', name: 'delegate_task', args: { name: '解释 Thread', task: '解释 Thread' } },
      { type: 'tool-call', id: 'delegate_b', name: 'delegate_task', args: { name: '解释 Turn', task: '解释 Turn' } },
    ], 'tool-calls'),
    fails ? new Error('子任务模型失败') : response([{ type: 'text', text: 'Thread 保存连续对话' }]),
    response([{ type: 'text', text: 'Turn 表示一次执行' }]),
    response([{ type: 'text', text: fails ? '部分任务失败' : '两项解释已汇总' }]),
  ])
  const storage = sqliteStore({ dataDir })
  const result = await runAgent({
    agent: coordinator,
    model: model.model,
    store: storage,
    workspace: { id: 'subagents', rootDir },
    input: '请委派两个任务后汇总',
    subagentMode: 'explicitOnly',
  })
  expect(result.status).toBe('completed')
  expect(model.requests).toHaveLength(4)
  const lease = await storage()
  try {
    const edges = await lease.store.turnSpawnEdges.listChildren(result.turnId)
    expect(edges).toHaveLength(2)
    expect(new Set(edges.map(edge => edge.childTurnId)).size).toBe(2)
    expect(new Set(edges.map(edge => edge.parentToolCallId)).size).toBe(2)
    const turns = await Promise.all(edges.map(edge => lease.store.turns.read(edge.childTurnId)))
    expect(turns.map(turn => turn?.status).sort()).toEqual(fails ? ['completed', 'failed'] : ['completed', 'completed'])
    const results = model.requests[3]!.messages.flatMap(message => message.parts).filter(part => part.type === 'tool-result')
    expect(results).toHaveLength(2)
    expect(results.map(part => part.result).join('\n')).toContain(fails ? 'failed' : 'completed')
  }
  finally { await lease.release() }
})
