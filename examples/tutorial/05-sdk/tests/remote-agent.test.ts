/**
 * Tutorial 05 验收：只作为远程客户端连接 Tutorial 04，验证订阅、工具输出与最终快照
 *
 * 模型和服务端资源仍由 04-server 的入口装配；本文件不创建引擎、不访问数据库
 * 不加载 .env，也不连接真实模型，所有请求都通过本机 HTTP / SSE 完成
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { createExampleServer } from '../../04-server/src/app/run'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { runRemoteTask } from '../src/app/run'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('SDK 教程调用服务端时间工具，并对事件与最终快照中的回复、思考和工具去重', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-sdk-tutorial-test-'))
  const key = 'sdk-tutorial-test-credential'
  // 测试配置独立于用户 .env；服务端只通过所属入口读取变量，客户端只收到连接凭据
  vi.stubEnv('ELMINO_DATA_DIR', root)
  vi.stubEnv('ELMINO_SERVER_KEY', key)
  vi.stubEnv('ELMINO_CORS_ORIGINS', '')
  const model = createModel([
    response([
      { type: 'reasoning', text: '读取服务端时间' },
      { type: 'tool-call', id: 'clock_call', name: 'current_time', args: {} },
    ], 'tool-calls'),
    response([
      { type: 'reasoning', text: '  ' },
      { type: 'text', text: '' },
      { type: 'text', text: '远程调用已完成' },
    ]),
  ])
  const server = createExampleServer(() => model.model)
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  onTestFinished(async () => {
    output.mockRestore()
    await server.close()
    await server.elmino.close()
    await rm(root, { recursive: true, force: true })
  })
  const url = await server.start({ port: 0, hostname: '127.0.0.1', shutdownSignals: false })
  vi.stubEnv('ELMINO_SERVER_URL', url)

  // 与命令行入口调用同一个教学流程：先订阅，再提交，最后读取服务端权威快照
  const state = await runRemoteTask()
  expect(state.turns).toMatchObject([{ status: 'completed' }])
  const parts = state.messages.flatMap(message => message.parts)
  expect(parts).toContainEqual(expect.objectContaining({ type: 'text', text: '远程调用已完成' }))
  expect(parts).toContainEqual(expect.objectContaining({
    type: 'tool',
    toolName: 'current_time',
    providerCallId: 'clock_call',
    status: 'completed',
    output: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/u),
  }))

  // 同一片段可能同时出现在流事件、消息快照中；每项只展示一次，忽略空思考与空回复
  const printed = output.mock.calls.flat().filter((value): value is string => typeof value === 'string')
  expect(printed.filter(value => value.startsWith('回复：'))).toEqual(['回复：\n远程调用已完成'])
  expect(printed.filter(value => value.startsWith('思考：'))).toEqual(['思考：\n读取服务端时间'])
  expect(printed.filter(value => value.startsWith('工具 current_time：'))).toHaveLength(1)
  expect(printed).toContain('持久化 Turn 状态：')
  expect(printed).toContain('completed')
  expect(printed.join('\n')).not.toContain('请调用工具读取 Server 当前时间')
})
