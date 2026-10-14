import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { NodeSQLiteSession } from 'drizzle-orm/node-sqlite/session'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { runtimeRelations, transcriptMessages } from '../src/drizzle/schema/index.js'
import { testFiles } from './support/files.js'
import { testSubagentRole } from './support/subagent.js'

/** -------------------- 测试状态 -------------------- */
let root = ''
let store: Awaited<ReturnType<typeof SqliteStore.create>>

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'elmino-relations-'))
  const blobStore = LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') })
  store = await SqliteStore.create({ dataDir: path.join(root, 'db'), blobStore })
  await store.threads.upsert({ id: 'owner', dir: '.', agentId: 'code' })
  await store.turns.create({
    id: 'turn',
    threadId: 'owner',
    status: 'running',
    modelConfig: { id: 'model_test' },
    subagentRole: testSubagentRole,
    subagentRoles: [],
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
  })
})

afterEach(async () => {
  await store.close()
  await rm(root, { force: true, recursive: true })
})

/** -------------------- 测试 -------------------- */
test('part relation filters ownership in one indexed query without loading sibling content', async () => {
  const message = await store.canonical.append({
    threadId: 'owner',
    turnId: 'turn',
    role: 'assistant',
    parts: [
      { id: 'selected', type: 'text', content: { type: 'text', text: '选中正文' } },
      { id: 'sibling', type: 'text', content: { type: 'text', text: '大正文'.repeat(100_000) } },
    ],
  })
  const queries = vi.spyOn(NodeSQLiteSession.prototype, 'prepareQuery')

  try {
    expect(await store.canonical.readPart('owner', 'selected')).toEqual(message.parts[0])
    expect(queries).toHaveBeenCalledTimes(1)
    const [query] = queries.mock.calls[0]!
    // 单条 Part 只返回自身 BLOB，父 Message 只参与 EXISTS 过滤
    expect(query.sql).toContain('exists')
    expect(query.sql).not.toContain('json_group_array')
    expect(query.sql.match(/content_blob/g)).toHaveLength(2)
    const client = new DatabaseSync(path.join(root, 'db', 'store.db'))
    try {
      const plan = client.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(
        ...query.params.map(value => typeof value === 'number' ? value : String(value)),
      )
      const details = plan.map(row => String(row.detail))
      expect(details).toContainEqual(expect.stringMatching(/SEARCH d0 USING INDEX .* \(id=\?\)/))
      expect(details).toContainEqual(expect.stringMatching(/SEARCH f0 USING INDEX .* \(id=\?\)/))
      expect(details.some(detail => /SCAN (?:d0|f0)/.test(detail))).toBe(false)
    }
    finally {
      client.close()
    }
    expect(await store.canonical.readPart('other', 'selected')).toBeUndefined()
    expect(await store.canonical.readPart('owner', 'missing')).toBeUndefined()
  }
  finally {
    queries.mockRestore()
  }
})

test('part relation sees transaction-local content and disappears after rollback', async () => {
  await expect(store.transaction(async (tx) => {
    const message = await tx.canonical.append({
      threadId: 'owner',
      turnId: 'turn',
      role: 'assistant',
      parts: [{ id: 'rolled_back', type: 'text', content: { type: 'text', text: '未提交' } }],
    })
    expect(await tx.canonical.readPart('owner', 'rolled_back')).toEqual(message.parts[0])
    expect(await tx.canonical.readPart('other', 'rolled_back')).toBeUndefined()
    throw new Error('rollback relation')
  })).rejects.toThrow('rollback relation')
  expect(await store.canonical.readPart('owner', 'rolled_back')).toBeUndefined()
})

test('runtime relations distinguish execution ownership, message kinds and spawn directions', async () => {
  const client = new DatabaseSync(path.join(root, 'db', 'store.db'))
  const db = drizzle({ client, relations: runtimeRelations })

  try {
    const parentTurn = (await store.turns.read('turn'))!
    for (const id of ['child', 'second_child', 'unrelated']) {
      await store.threads.upsert({ id, dir: '.', agentId: 'code' })
      await store.turns.create({ ...parentTurn, id: `turn_${id}`, threadId: id })
    }
    for (const childThreadId of ['child', 'second_child'])
      await store.spawnEdges.create({ parentThreadId: 'owner', childThreadId, ownerId: 'subagent' })
    const step = await store.steps.create({ turnId: 'turn', input: 10, estimated: 10 })
    const artifact = await store.artifacts.write({ threadId: 'owner', contentKind: 'text', contentText: '归档内容' })
    const message = await store.canonical.append({
      id: 'canonical',
      threadId: 'owner',
      turnId: 'turn',
      role: 'tool',
      parts: [{ id: 'result', type: 'tool-result', content: { type: 'tool-result', text: '结果' } }],
    })
    // 这里只检查表关系，不读取 UI 正文；消息投影和 Canonical Message 使用不同 ID 防止连错表
    await db.insert(transcriptMessages).values({
      id: 'transcript',
      thread_id: 'owner',
      turn_id: 'turn',
      seq: 1,
      content_blob: Buffer.from('{}'),
    })
    for (const id of ['spawn_tool', 'plain_tool']) {
      await store.toolCalls.create({
        id,
        turnId: 'turn',
        assistantMessageId: 'transcript',
        assistantPartId: `${id}_part`,
        providerCallId: `${id}_provider`,
        name: 'subagent',
        args: {},
      })
    }
    await store.toolCalls.update('spawn_tool', { resultPartId: 'result' })
    await store.turnSpawnEdges.create({ childTurnId: 'turn_child', parentToolCallId: 'spawn_tool' })

    const thread = await db.query.threads.findFirst({
      where: { id: 'owner' },
      columns: { id: true },
      with: {
        turns: {
          columns: { id: true },
          with: {
            thread: { columns: { id: true } },
            steps: { columns: { id: true }, with: { turn: { columns: { id: true } } } },
            canonicalMessages: { columns: { id: true } },
            transcriptMessages: { columns: { id: true } },
            toolCalls: { columns: { id: true }, orderBy: { id: 'asc' } },
            spawnEdge: true,
          },
        },
        canonicalMessages: { columns: { id: true } },
        transcriptMessages: { columns: { id: true } },
        artifacts: { columns: { id: true }, with: { thread: { columns: { id: true } } } },
        parentSpawnEdge: true,
        childSpawnEdges: {
          columns: { child_thread_id: true },
          orderBy: { child_thread_id: 'asc' },
          with: { parentThread: { columns: { id: true } }, childThread: { columns: { id: true } } },
        },
      },
    })
    expect(thread).toEqual({
      id: 'owner',
      turns: [{
        id: 'turn',
        thread: { id: 'owner' },
        steps: [{ id: step.id, turn: { id: 'turn' } }],
        canonicalMessages: [{ id: 'canonical' }],
        transcriptMessages: [{ id: 'transcript' }],
        toolCalls: [{ id: 'plain_tool' }, { id: 'spawn_tool' }],
        spawnEdge: null,
      }],
      canonicalMessages: [{ id: 'canonical' }],
      transcriptMessages: [{ id: 'transcript' }],
      artifacts: [{ id: artifact.id, thread: { id: 'owner' } }],
      parentSpawnEdge: null,
      childSpawnEdges: ['child', 'second_child'].map(id => ({
        child_thread_id: id,
        parentThread: { id: 'owner' },
        childThread: { id },
      })),
    })

    const tool = await db.query.toolCalls.findFirst({
      where: { id: 'spawn_tool' },
      columns: { id: true },
      with: {
        turn: { columns: { id: true } },
        assistantMessage: {
          columns: { id: true },
          with: {
            thread: { columns: { id: true } },
            turn: { columns: { id: true } },
            toolCalls: { columns: { id: true }, orderBy: { id: 'asc' } },
          },
        },
        resultPart: {
          columns: { id: true },
          with: {
            resultToolCalls: { columns: { id: true } },
            message: {
              columns: { id: true },
              with: {
                thread: { columns: { id: true } },
                turn: { columns: { id: true } },
                parts: { columns: { id: true } },
              },
            },
          },
        },
        spawnEdge: {
          columns: { child_turn_id: true },
          with: {
            parentToolCall: { columns: { id: true } },
            childTurn: { columns: { id: true }, with: { thread: { columns: { id: true } } } },
          },
        },
      },
    })
    expect(tool).toEqual({
      id: 'spawn_tool',
      turn: { id: 'turn' },
      assistantMessage: {
        id: 'transcript',
        thread: { id: 'owner' },
        turn: { id: 'turn' },
        toolCalls: [{ id: 'plain_tool' }, { id: 'spawn_tool' }],
      },
      resultPart: {
        id: 'result',
        resultToolCalls: [{ id: 'spawn_tool' }],
        message: { id: message.id, thread: { id: 'owner' }, turn: { id: 'turn' }, parts: [{ id: 'result' }] },
      },
      spawnEdge: {
        child_turn_id: 'turn_child',
        parentToolCall: { id: 'spawn_tool' },
        childTurn: { id: 'turn_child', thread: { id: 'child' } },
      },
    })
    expect(await db.query.toolCalls.findFirst({
      where: { id: 'plain_tool' },
      columns: { id: true },
      with: { resultPart: true, spawnEdge: true },
    })).toEqual({ id: 'plain_tool', resultPart: null, spawnEdge: null })
    expect(await db.query.threads.findFirst({
      where: { id: 'child' },
      columns: { id: true },
      with: {
        parentSpawnEdge: { columns: { parent_thread_id: true } },
        childSpawnEdges: true,
        turns: { columns: { id: true }, with: { spawnEdge: { columns: { parent_tool_call_id: true } } } },
      },
    })).toEqual({
      id: 'child',
      parentSpawnEdge: { parent_thread_id: 'owner' },
      childSpawnEdges: [],
      turns: [{ id: 'turn_child', spawnEdge: { parent_tool_call_id: 'spawn_tool' } }],
    })
  }
  finally {
    client.close()
  }
})
