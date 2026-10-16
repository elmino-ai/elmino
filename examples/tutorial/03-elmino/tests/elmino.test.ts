/**
 * 教程验收：通过真正的 Elmino、SQLite 与时间工具完成本地两轮调用
 *
 * 确定性模型替代外部请求，断言第二轮确实收到第一轮工具结果
 * 测试同时验证示例退出后能重新打开历史，以及异常路径也会关闭实例
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { createExampleElmino } from '../src/app/elmino'
import { runExample } from '../src/app/run'

afterEach(() => vi.unstubAllEnvs())

test('复用应用和线程，第二轮收到第一轮工具结果，关闭后重建仍能读取两轮历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-app-tutorial-test-'))
  vi.stubEnv('ELMINO_DATA_DIR', root)
  const first = createModel([
    response([{ type: 'tool-call', id: 'clock_call', name: 'current_time', args: {} }], 'tool-calls'),
    response([{ type: 'reasoning', text: '已读取本机时间' }, { type: 'text', text: '第一轮完成' }]),
  ])
  const second = createModel([response([{ type: 'text', text: '沿用上一轮时间，第二轮完成' }])])
  first.model.config.id = 'deepseek'
  second.model.config.id = 'deepseek'
  const model = vi.fn().mockReturnValueOnce(first.model).mockReturnValueOnce(second.model)
  const app = createExampleElmino({ deepseek: model })
  const restored = createExampleElmino({ deepseek: model })
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  onTestFinished(async () => {
    output.mockRestore()
    await Promise.allSettled([app.close(), restored.close()])
    await rm(root, { recursive: true, force: true })
  })

  const state = await runExample(app)
  expect(app.closed).toBe(true)
  expect(state.turns).toHaveLength(2)
  expect(state.turns.every(turn => turn.status === 'completed')).toBe(true)
  expect(new Set(state.turns.map(turn => turn.id)).size).toBe(2)
  const tool = state.messages.flatMap(message => message.parts).find(part => part.type === 'tool')
  expect(tool).toMatchObject({ toolName: 'current_time', status: 'completed' })
  if (tool?.type !== 'tool')
    throw new Error('缺少第一轮的工具结果')
  expect(tool.output).toEqual(expect.stringMatching(/\d{4}-\d{2}-\d{2}T/u))
  expect(JSON.stringify(second.requests[0]?.messages)).toContain(tool.output)
  expect(output.mock.calls.flat()).toContain('思考：\n已读取本机时间')
  expect(output.mock.calls).toContainEqual(['已完成轮数：', 2])
  expect(model).toHaveBeenCalledTimes(2)

  const history = await restored.getThread({ agentId: 'clock', workspaceId: 'example', threadId: state.threadId })
  expect(history.messages).toEqual(state.messages)
  expect(history.turns).toEqual(state.turns)
  expect(model).toHaveBeenCalledTimes(2)
})

test('模型装配失败时向入口报告原错误并关闭应用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-app-tutorial-error-'))
  vi.stubEnv('ELMINO_DATA_DIR', root)
  const app = createExampleElmino({
    deepseek: () => {
      throw new Error('测试模型不可用')
    },
  })
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  onTestFinished(async () => {
    output.mockRestore()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await expect(runExample(app)).rejects.toThrow('测试模型不可用')
  expect(app.closed).toBe(true)
})
