import type { LocalWorkspace } from '@elmino/core'
import type { RuntimeCreateContext } from '@elmino/runtime'
import type { ServerAuthorization } from '../src/index'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { defineElmino } from '@elmino/core'
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createEngineStore, createTestRuntime, disposeEngineStore } from '../../engine/tests/support/engine'
import { createModel, response } from '../../engine/tests/support/model'
import { defineServer } from '../src/index'

test.each(['.', 'nested'])('固定工作区从持久目录 %s 执行，配置修改不改变已定义的作用域', async (dir) => {
  const { root, store } = await createEngineStore()
  await mkdir(path.join(root, 'nested'))
  const createRuntime = vi.fn(({ location }: RuntimeCreateContext) => createTestRuntime(location))
  const agent = defineAgent({ id: 'writer', systemPrompt: '完成任务', runtime: { create: createRuntime } })
  const workspace: LocalWorkspace = { id: 'fixed', rootDir: path.relative(process.cwd(), root), store }
  const model = createModel([response([{ type: 'text', text: '固定工作区完成' }])])
  const modelFactory = vi.fn(() => model.model)
  const server = defineServer({
    elmino: defineElmino({
      agents: { writer: agent },
      workspace,
      models: modelFactory,
    }),
    apiKey: 'test-fixed-key',
  })
  onTestFinished(async () => {
    await server.close()
    await server.elmino.close()
    await disposeEngineStore(root, store)
  })
  const client = Client.create({
    baseUrl: 'https://elmino.test',
    apiKey: 'test-fixed-key',
    fetch: (input, init) => server.fetch(new Request(input, init)),
  })
  workspace.id = 'changed'
  workspace.rootDir = '/changed'
  const target = { agentId: 'writer', workspaceId: 'fixed', threadId: createId('thread') }
  await expect(client.rpc.thread.list({ agentId: target.agentId, workspaceId: 'other' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(modelFactory).not.toHaveBeenCalled()
  await store.threads.upsert({ id: target.threadId, agentId: 'writer', dir, metadata: { workspaceId: 'fixed' } })
  const turnId = createId('turn')
  await client.rpc.turn.create({ ...target, turnId, input: [{ type: 'text', text: '执行任务' }] })
  await vi.waitFor(async () => {
    expect((await store.turns.read(turnId))?.status).toBe('completed')
  })
  expect(createRuntime).toHaveBeenCalledOnce()
  expect(createRuntime.mock.calls[0]![0].location).toEqual({
    workspaceId: 'fixed',
    workspaceKind: 'project',
    workspaceRoot: root,
    dir,
    cwd: path.resolve(root, dir),
  })
  const state = await client.rpc.thread.get(target)
  expect(state.messages.flatMap(message => message.parts))
    .toContainEqual(expect.objectContaining({ type: 'text', text: '固定工作区完成' }))
  await server.close()
  expect((await store.turns.read(turnId))?.status).toBe('completed')
})

test.each(['..', '/outside'])('固定工作区拒绝越界持久目录 %s，不进入模型采样或 Runtime', async (dir) => {
  const { root, store } = await createEngineStore()
  const createRuntime = vi.fn(() => {
    throw new Error('不应创建 Runtime')
  })
  const model = vi.fn(() => {
    throw new Error('不应装配模型')
  })
  const agent = defineAgent({ id: 'writer', systemPrompt: '完成任务', runtime: { create: createRuntime } })
  const server = defineServer({
    elmino: defineElmino({
      agents: { writer: agent },
      workspace: { id: 'fixed', rootDir: root, store },
      models: model,
    }),
  })
  onTestFinished(async () => {
    await server.close()
    await server.elmino.close()
    await disposeEngineStore(root, store)
  })
  const threadId = createId('thread')
  await store.threads.upsert({ id: threadId, agentId: 'writer', dir, metadata: { workspaceId: 'fixed' } })
  const client = Client.create({ baseUrl: 'https://elmino.test', fetch: (input, init) => server.fetch(new Request(input, init)) })
  await expect(client.rpc.thread.get({ agentId: 'writer', workspaceId: 'fixed', threadId })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  expect(createRuntime).not.toHaveBeenCalled()
  expect(model).not.toHaveBeenCalled()
})

test('apiKey 同时约束 REST 与 RPC，authorize 不能绕过凭据且仍逐项检查 batch', async () => {
  const authorize = vi.fn(({ path }: ServerAuthorization) => path[0] === 'meta')
  const server = defineServer({
    elmino: defineElmino({
      agents: {},
      workspace: () => { throw new Error('健康检查不应加载工作区') },
      models: () => { throw new Error('健康检查不应加载模型') },
    }),
    apiKey: 'test-definition-key',
    authorize,
  })
  onTestFinished(() => server.close())
  const client = (apiKey?: string) => Client.create({
    baseUrl: 'https://elmino.test',
    apiKey,
    fetch: (input, init) => server.fetch(new Request(input, init)),
  })
  await expect(client().rpc.meta.health({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(client('wrong-key').rpc.meta.health({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect((await server.fetch(new Request('https://elmino.test/api/health'))).status).toBe(401)
  expect(authorize).not.toHaveBeenCalled()
  const authenticated = client('test-definition-key')
  const [health, agents] = await Promise.allSettled([authenticated.rpc.meta.health({}), authenticated.rpc.agent.list({})])
  expect(health).toEqual({ status: 'fulfilled', value: { status: 'ok' } })
  expect(agents).toMatchObject({ status: 'rejected', reason: { code: 'UNAUTHORIZED' } })
  expect(authorize.mock.calls.map(([context]) => context.path)).toEqual([['meta', 'health'], ['agent', 'list']])
  const rest = await server.fetch(new Request('https://elmino.test/api/health', {
    headers: { authorization: 'Bearer test-definition-key' },
  }))
  expect(rest.status).toBe(200)
})

test.each(['', '  '])('defineServer 拒绝空白 apiKey %j', (apiKey) => {
  expect(() => defineServer({
    elmino: defineElmino({
      agents: {},
      workspace: () => { throw new Error('不应加载工作区') },
      models: () => { throw new Error('不应加载模型') },
    }),
    apiKey,
  })).toThrow('apiKey 不能为空')
})
