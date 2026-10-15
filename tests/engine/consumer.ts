/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { TurnRequest } from '@elmino/engine'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine, getBuiltinSubagentRoles, LocalSubagentRoles, runAgent } from '@elmino/engine'
import { JobQueue } from '@elmino/engine/job'
import { extractText } from '@elmino/llm'
import { defineRuntime } from '@elmino/runtime/local'
import { createId } from '@elmino/shared'
import { sqliteStore, SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import * as z from 'zod'
import { testFiles } from '../../packages/engine/tests/support/files'
import { createModel, response } from '../../packages/engine/tests/support/model'
import { createMockSandbox } from '../../packages/loop/tests/support/sandbox'

const roles = LocalSubagentRoles.create({ dir: path.resolve('roles') })
await roles.initialize()
assert.deepEqual((await roles.resolve()).map(role => role.id), ['default', 'explorer', 'worker'])
const builtins = getBuiltinSubagentRoles()
builtins[0]!.name = 'changed after reading'
assert.notEqual(getBuiltinSubagentRoles()[0]!.name, builtins[0]!.name)
const jobs = JobQueue.create(1)
assert.equal(await jobs.submit('consumer', () => Promise.resolve('published')), 'published')
await jobs.close()

const storage = {
  dataDir: path.resolve('database'),
  blobStore: LocalBlobStore.create({ files: testFiles, rootDir: path.resolve('blobs') }),
}
let store = await SqliteStore.create(storage)
let executions = 0
let artifactId = ''
let binaryArtifactId = ''
const threadId = createId('thread')
const turnId = createId('turn')
const tools = defineTools({
  work: {
    description: 'Save the approved result',
    schema: z.object({ value: z.string() }),
    approval: 'auto',
    execute: async ({ value }, context) => {
      executions++
      const call = (await store.toolCalls.list({ turnId }))
        .find(call => call.id === context.toolCallId)
      assert.equal(call?.status, 'running')
      const artifact = await store.artifacts.write({
        threadId: call!.threadId,
        contentKind: 'text',
        contentText: value,
      })
      artifactId = artifact.id
      const binary = await store.artifacts.write({
        threadId: call!.threadId,
        contentKind: 'bytes',
        contentBytes: new TextEncoder().encode(value),
      })
      binaryArtifactId = binary.id
      return value
    },
  },
})
const agent = defineAgent({
  id: 'consumer',
  systemPrompt: 'Use the supplied tools',
  tools,
  runtime: defineRuntime(({ location }) => createMockSandbox({ cwd: location.cwd })),
})
let engine = AgentEngine.create({ consumer: agent })
const firstModel = createModel([
  response([{ type: 'tool-call', id: 'native_work', name: 'work', args: { value: 'approved result' } }], 'tool-calls'),
])
const request: TurnRequest = {
  agentId: agent.id,
  threadId,
  turnId,
  model: firstModel.model,
  input: [{ type: 'text', text: 'Save the result after approval' }],
  approvalMode: 'request',
  location: {
    workspaceId: 'workspace_consumer',
    workspaceKind: 'project',
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    dir: '.',
  },
}
try {
  const initial = engine.run(request, store)
  await initial.accepted
  await initial.completed
  assert.equal(executions, 0)
  const pending = await store.turns.read(request.turnId)
  assert.equal(pending?.status, 'interrupted')
  const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))
  assert.ok(interrupt)
  assert.equal(interrupt.interaction, 'tool_approval')
  assert.deepEqual((await store.steps.list(request.turnId)).map(step => step.status), ['completed'])

  await engine.close()
  await store.close()
  store = await SqliteStore.create(storage)
  engine = AgentEngine.create({ consumer: agent })
  const entered = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const restored = createModel([async () => {
    entered.resolve()
    await completed.promise
    return response([{ type: 'text', text: 'Task complete' }])
  }])
  const resumeRequest: TurnRequest = {
    ...request,
    model: restored.model,
    input: [],
    resume: { interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'native_work' }] } },
  }
  const invalid = engine.resume({
    ...resumeRequest,
    resume: { interruptId: interrupt.id, response: { decisions: [{ type: 'approve', callId: 'other_call' }] } },
  }, store)
  await Promise.all([assert.rejects(invalid.accepted, /无效/u), assert.rejects(invalid.completed, /无效/u)])
  assert.equal((await store.turns.read(request.turnId))?.status, 'interrupted')
  assert.equal(executions, 0)

  const resumed = engine.resume(resumeRequest, store)
  await resumed.accepted
  await entered.promise
  try {
    assert.equal(executions, 1)
    const duplicate = engine.resume(resumeRequest, store)
    await Promise.all([assert.rejects(duplicate.accepted), assert.rejects(duplicate.completed)])
  }
  finally { completed.resolve() }
  assert.equal(extractText((await resumed.completed)!), 'Task complete')
  assert.equal((await store.turns.read(request.turnId))?.status, 'completed')
  assert.deepEqual((await store.steps.list(request.turnId)).map(step => step.status), ['completed', 'completed'])
  assert.deepEqual((await store.toolCalls.list({ turnId })).map(call => ({
    providerCallId: call.providerCallId,
    status: call.status,
  })), [{ providerCallId: 'native_work', status: 'completed' }])
  assert.ok(restored.requests[0]!.messages.flatMap(message => message.parts)
    .some(part => part.type === 'tool-result' && part.callId === 'native_work' && part.result === 'approved result'))
  const stale = engine.resume(resumeRequest, store)
  await Promise.all([assert.rejects(stale.accepted), assert.rejects(stale.completed)])
  assert.equal(executions, 1)

  await engine.close()
  await store.close()
  store = await SqliteStore.create(storage)
  assert.equal((await store.artifacts.readText(artifactId))?.content, 'approved result')
  const binary = await store.artifacts.read(binaryArtifactId)
  assert.equal(binary?.storage, 'blob')
  assert.ok(binary?.blobKey)
  assert.equal(new TextDecoder().decode(await storage.blobStore.read(binary.blobKey)), 'approved result')
  assert.equal((await store.turns.read(request.turnId))?.status, 'completed')
  assert.equal((await store.steps.list(request.turnId)).length, 2)

  const single = await runAgent({
    agent,
    model: createModel([response([{ type: 'text', text: '单次任务完成' }])]).model,
    store,
    workspace: { id: 'workspace_consumer', rootDir: process.cwd() },
    input: '执行一次独立任务',
  })
  assert.equal(single.status, 'completed')
  assert.equal(extractText(single.message!), '单次任务完成')
  assert.notEqual(single.threadId, threadId)
  assert.equal((await store.turns.read(single.turnId))?.status, 'completed')
}
finally {
  await engine.close()
  await store.close()
}

const configured = sqliteStore({ dataDir: path.resolve('configured') })
const configuredResult = await runAgent({
  agent,
  model: createModel([response([{ type: 'text', text: '配置存储完成' }])]).model,
  store: configured,
  workspace: { id: 'configured', rootDir: process.cwd() },
  input: '使用配置存储执行任务',
})
assert.equal(configuredResult.status, 'completed')
const lease = await configured()
try {
  assert.equal((await lease.store.turns.read(configuredResult.turnId))?.status, 'completed')
}
finally { await lease.release() }
