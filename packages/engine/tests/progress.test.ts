import type { ToolExecutionContext } from '@elmino/tool'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { defineRuntime } from '@elmino/runtime/local'
import { createId, isPlainRecord } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { defineTools } from '@elmino/tool'
import { expect, onTestFinished, test } from 'vitest'
import * as z from 'zod'
import { testFiles } from './support/files'
import { createModel, response } from './support/model'
import { createTestSandbox } from './support/sandbox'

test.each(['interrupt', 'close'] as const)('%s drains accepted progress before settlement', async (operation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-engine-progress-'))
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let callback: ToolExecutionContext['onToolProgress']
  let progress: Promise<void> | undefined
  const store = await SqliteStore.create({
    dataDir: path.join(root, 'database'),
    blobStore: LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') }),
  })
  const agent = defineAgent({
    id: 'progress',
    systemPrompt: 'Execute the task',
    runtime: defineRuntime(() => createTestSandbox({ cwd: root, allowedRoots: [root] })),
    tools: defineTools({
      work: {
        description: 'Progress until cancelled',
        schema: z.object({}),
        execute: (_, context) => {
          callback = context.onToolProgress
          progress = Promise.resolve(callback?.('partial'))
          progress.catch(() => undefined)
          return new Promise<string>((_resolve, reject) => {
            context.signal!.addEventListener('abort', () => reject(new Error('tool aborted')), { once: true })
          })
        },
      },
    }),
  })
  const engine = AgentEngine.create({ progress: agent })
  onTestFinished(async () => {
    release.resolve()
    await engine.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const threadId = createId('thread')
  const turnId = createId('turn')
  const statuses: string[] = []
  const execution = engine.run({
    agentId: agent.id,
    threadId,
    turnId,
    model: createModel([
      response([{ type: 'tool-call', id: 'native_work', name: 'work', args: {} }], 'tool-calls'),
    ]).model,
    input: [{ type: 'text', text: 'Execute the task' }],
    approvalMode: 'fullAccess',
    location: {
      workspaceId: 'workspace_progress',
      workspaceKind: 'project',
      workspaceRoot: root,
      dir: '.',
      cwd: root,
    },
    onRuntimeEvent: async (event) => {
      if (event.type === 'message.part.updated' && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.part) && event.payload.part.type === 'tool') {
        statuses.push(String(event.payload.part.status))
      }
      if (event.type === 'message.part.delta' && isPlainRecord(event.payload)
        && isPlainRecord(event.payload.delta) && typeof event.payload.delta.output === 'string') {
        started.resolve()
        await release.promise
      }
    },
  }, store)
  const completed = execution.completed.catch((error: unknown) => error)
  await execution.accepted
  await started.promise
  let stopped = false
  const stopping = (operation === 'interrupt'
    ? engine.interrupt({ agentId: agent.id, threadId, turnId, store })
    : engine.close()).then((result) => {
    stopped = true
    return result
  })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect((await store.toolCalls.list({ turnId }))[0]?.status).toBe('running')
    expect((await store.turns.read(turnId))?.status).toBe('running')
  }
  finally { release.resolve() }
  await stopping
  expect(await completed).toBeInstanceOf(Error)
  await progress
  const [terminal] = await store.toolCalls.list({ turnId })
  expect(terminal).toMatchObject({ status: 'failed', completedAt: expect.any(String) })
  expect((await store.turns.read(turnId))?.status).toBe('interrupted')
  expect(statuses.at(-1)).toBe('failed')
  const eventCount = statuses.length
  await callback?.('late output')
  expect(statuses).toHaveLength(eventCount)
  expect((await store.toolCalls.list({ turnId }))[0]).toEqual(terminal)
})
