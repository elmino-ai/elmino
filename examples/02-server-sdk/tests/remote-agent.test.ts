import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listen } from '@elmino/server/node'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../../packages/engine/tests/support/model'
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
    response([{ type: 'text', text: '远程调用已完成' }]),
  ])
  const key = 'example-test-credential'
  const server = createServer(model.model, store, workspaceRoot, key)
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
  expect(output.mock.calls.flat().join('\n')).toContain('远程调用已完成')
})
