/**
 * 验收说明：使用确定性模型验证本例的真实工具、运行状态与资源退出行为
 * 不加载 .env，也不调用真实模型；可用这些断言对照 src 中说明的成功和失败路径
 */
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'
import { expect, onTestFinished, test } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { createWriter } from '../src/agent/agent'

/** 每次任务使用自己的文件目录和事件记录 */
async function createContext() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-hooks-test-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }))
  const logs: string[] = []
  const agent = createWriter(message => logs.push(message))
  return { dataDir, rootDir, logs, agent }
}

test('稳定上下文进入模型，工具改写实际内容，Turn 清理在返回前完成', async () => {
  const context = await createContext()
  const model = createModel([
    response([{ type: 'tool-call', id: 'save_note', name: 'write_note', args: { text: '  Hello from hooks  ' } }], 'tool-calls'),
    response([{ type: 'text', text: '已保存' }]),
  ])
  const result = await runAgent({
    agent: context.agent,
    model: model.model,
    store: sqliteStore({ dataDir: context.dataDir }),
    workspace: { id: 'hooks', rootDir: context.rootDir },
    input: '保存便签',
  })
  expect(result.status).toBe('completed')
  expect(await readFile(path.join(context.rootDir, 'result.txt'), 'utf8')).toBe('Hello from hooks')
  expect(model.requests[0]!.system.map(part => part.text).join('\n')).toContain('只保存用户指定的内容')
  expect(context.logs).toEqual([
    `Turn 启动 ${result.turnId}`,
    '工具完成 write_note completed',
    '准备保存执行快照 completed',
    `Turn 清理回调 ${result.turnId}`,
  ])
})

test.each([
  { text: '[禁止写入] 此便签' },
  { text: 123 },
])('策略阻断或参数无效时不写文件，失败结果回到模型并清理资源：%j', async (args) => {
  const context = await createContext()
  const model = createModel([
    response([{ type: 'tool-call', id: 'blocked_note', name: 'write_note', args }], 'tool-calls'),
    response([{ type: 'text', text: '未保存便签' }]),
  ])
  const result = await runAgent({
    agent: context.agent,
    model: model.model,
    store: sqliteStore({ dataDir: context.dataDir }),
    workspace: { id: 'hooks', rootDir: context.rootDir },
    input: '测试未写入路径',
  })
  expect(result.status).toBe('completed')
  await expect(access(path.join(context.rootDir, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(model.requests[1]!.messages.flatMap(message => message.parts))
    .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool-result', callId: 'blocked_note' })]))
  expect(context.logs.at(-1)).toBe(`Turn 清理回调 ${result.turnId}`)
})
