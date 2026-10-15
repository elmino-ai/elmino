import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@elmino/sdk'
import { listen } from '@elmino/server/node'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../../packages/engine/tests/support/model'
import { startExampleServer } from '../src/app/run'
import { runRemoteTask } from '../src/client/run'
import { createServer } from '../src/server/create'
import { createStorage } from '../src/storage/storage'

test('示例经真实端口执行远程工具，打印过程并查询已持久化的线程', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-remote-example-test-'))
  const workspaceRoot = path.join(root, 'workspace')
  await mkdir(workspaceRoot)
  const store = await createStorage(root)
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
  const key = 'example-test-credential'
  const server = createServer(() => model.model, store, workspaceRoot, key)
  const http = await listen({ server })
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  onTestFinished(async () => {
    output.mockRestore()
    await server.close()
    await http.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const state = await runRemoteTask(http.url, key)
  const [turn] = await store.turns.list(state.threadId)
  expect(turn?.status).toBe('completed')
  expect(await store.steps.list(turn!.id)).toHaveLength(2)
  expect(await store.toolCalls.list({ turnId: turn!.id })).toMatchObject([
    { providerCallId: 'clock_call', status: 'completed' },
  ])
  expect(state.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ type: 'text', text: '远程调用已完成' }))
  expect(model.requests).toHaveLength(2)
  const printed = output.mock.calls.flat().filter((value): value is string => typeof value === 'string')
  expect(printed).toContain('回复：\n远程调用已完成')
  expect(printed.filter(value => value.startsWith('回复：'))).toEqual(['回复：\n远程调用已完成'])
  expect(printed.filter(value => value.startsWith('思考：'))).toEqual(['思考：\n读取服务端时间'])
  expect(printed.join('\n')).not.toContain('请调用工具读取 Server 当前时间')
})

test('常驻 Server 在客户端结束后继续服务，同目录重启仍可读取历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-persistent-server-test-'))
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
  const key = 'persistent-server-test-credential'
  let server: Awaited<ReturnType<typeof startExampleServer>> | undefined
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  onTestFinished(async () => {
    output.mockRestore()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  })
  server = await startExampleServer({ model, key, dataDir: root, port: 0 })
  const client = Client.create({ baseUrl: server.url, apiKey: key })
  const first = await runRemoteTask(server.url, key)
  expect(await client.rpc.meta.health({})).toEqual({ status: 'ok' })
  const second = await runRemoteTask(server.url, key)
  expect(second.threadId).not.toBe(first.threadId)
  expect(await client.rpc.meta.health({})).toEqual({ status: 'ok' })
  expect(model).toHaveBeenCalledTimes(2)
  expect(first.turns).toMatchObject([{ status: 'completed' }])
  expect(second.turns).toMatchObject([{ status: 'completed' }])

  await server.close()
  server = await startExampleServer({ model, key, dataDir: root, port: 0 })
  const restarted = Client.create({ baseUrl: server.url, apiKey: key })
  for (const state of [first, second]) {
    const historical = await restarted.rpc.thread.get({
      agentId: 'clock',
      workspaceId: 'example',
      threadId: state.threadId,
    })
    expect(historical.turns).toEqual(state.turns)
    expect(historical.messages).toEqual(state.messages)
  }
  expect(await restarted.rpc.meta.health({})).toEqual({ status: 'ok' })
  expect(model).toHaveBeenCalledTimes(2)
})
