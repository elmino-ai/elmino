/**
 * Tutorial 04 验收：常驻 Server 独立接纳多个任务，并在同数据目录重启后保留历史
 *
 * 测试直接使用公开 SDK 发起请求，不依赖后续 SDK 教程的实现
 * 不加载 .env、不调用真实模型，也不通过数据库内部结构判断是否成功
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../../../packages/engine/tests/support/model'
import { createExampleServer } from '../src/app/run'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('常驻 Server 接纳两次独立任务，关闭并重建后仍能通过 HTTP 查询两份历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-server-tutorial-test-'))
  const key = 'server-tutorial-test-credential'
  vi.stubEnv('ELMINO_DATA_DIR', root)
  vi.stubEnv('ELMINO_SERVER_KEY', key)
  vi.stubEnv('ELMINO_CORS_ORIGINS', '')
  const models = [
    createModel([
      response([{ type: 'tool-call', id: 'first_clock', name: 'current_time', args: {} }], 'tool-calls'),
      response([{ type: 'text', text: '第一次远程任务完成' }]),
    ]),
    createModel([
      response([{ type: 'tool-call', id: 'second_clock', name: 'current_time', args: {} }], 'tool-calls'),
      response([{ type: 'text', text: '第二次远程任务完成' }]),
    ]),
  ]
  const model = vi.fn(() => {
    const next = models.shift()
    if (!next)
      throw new Error('历史查询不应重新解析模型')
    return next.model
  })
  let server: ReturnType<typeof createExampleServer> | undefined
  onTestFinished(async () => {
    await server?.close()
    await server?.elmino.close()
    await rm(root, { recursive: true, force: true })
  })
  server = createExampleServer(model)
  const url = await server.start({ port: 0, hostname: '127.0.0.1', shutdownSignals: false })
  const client = Client.create({ baseUrl: url, apiKey: key })
  const targets = [
    { agentId: 'clock', workspaceId: 'example', threadId: createId('thread') },
    { agentId: 'clock', workspaceId: 'example', threadId: createId('thread') },
  ]
  const historical = []

  // turn.create 表示任务已被接纳；只有后续查询的 Turn 终态才能表示模型和工具已经完成
  for (const [index, target] of targets.entries()) {
    const turnId = createId('turn')
    await client.rpc.turn.create({
      ...target,
      turnId,
      approvalMode: 'fullAccess',
      input: [{ type: 'text', text: '请调用工具读取 Server 当前时间' }],
    })
    await vi.waitFor(async () => {
      const state = await client.rpc.thread.get(target)
      expect(state.turns.find(turn => turn.id === turnId)?.status).toBe('completed')
    })
    const state = await client.rpc.thread.get(target)
    expect(state.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({
      type: 'text',
      text: index === 0 ? '第一次远程任务完成' : '第二次远程任务完成',
    }))
    historical.push(state)
    // 单个客户端请求结束后，原来的监听服务继续响应，不需要重新 start
    expect(await client.rpc.meta.health({})).toEqual({ status: 'ok' })
  }
  expect(model).toHaveBeenCalledTimes(2)

  // Server 与 Elmino 分别关闭；下一次装配读取同一 ELMINO_DATA_DIR 下的持久化记录
  await server.close()
  await server.elmino.close()
  server = createExampleServer(model)
  const restartedUrl = await server.start({ port: 0, hostname: '127.0.0.1', shutdownSignals: false })
  const restarted = Client.create({ baseUrl: restartedUrl, apiKey: key })
  for (const previous of historical) {
    const state = await restarted.rpc.thread.get({
      agentId: 'clock',
      workspaceId: 'example',
      threadId: previous.threadId,
    })
    expect(state.turns).toEqual(previous.turns)
    expect(state.messages).toEqual(previous.messages)
  }
  expect(await restarted.rpc.meta.health({})).toEqual({ status: 'ok' })
  // 只读历史不会重新向模型发起任务；模型工厂也没有为重启查询额外创建适配器
  expect(model).toHaveBeenCalledTimes(2)
})
