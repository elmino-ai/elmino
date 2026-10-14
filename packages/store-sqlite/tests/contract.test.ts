import type { BlobStore, RuntimeStore, RuntimeStoreTx, ThreadMessage } from '@elmino/store'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTokenUsage } from '@elmino/store'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { NodeSQLiteSession } from 'drizzle-orm/node-sqlite/session'
import { expect, test, vi } from 'vitest'
import { testFiles } from './support/files.js'
import { testSubagentRole, testSubagentRoles } from './support/subagent.js'

/** -------------------- 常量 -------------------- */
/** 测试路径稳定前缀 */
const testPathPrefix = 'elmino'

/** 触发默认 artifact blob 阈值的大文本 */
const largeArtifactContent = Array.from(
  { length: 3_000 },
  (_, index) => `line ${index + 1}`.padEnd(100, 'x'),
).join('\n')

/** -------------------- 测试 -------------------- */
test('sqlite store satisfies RuntimeStore contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-contract-`))
  const context = await createSqliteStore(root)

  try {
    await runStoreContract(context.store, context.blobStore)
  }
  finally {
    await context.store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('thread creation requires its identity fields while partial updates preserve them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-thread-input-`))
  const { store } = await createSqliteStore(root)

  try {
    await expect(store.threads.upsert({ id: 'thread_input', dir: '.' })).rejects.toThrow('创建线程需要指定目录和 Agent')
    await expect(store.threads.upsert({ id: 'thread_input', agentId: 'code' })).rejects.toThrow('创建线程需要指定目录和 Agent')
    expect(await store.threads.read('thread_input')).toBeUndefined()
    await store.threads.upsert({ id: 'thread_input', dir: '.', agentId: 'code' })
    expect(await store.threads.upsert({ id: 'thread_input', pinned: true })).toMatchObject({
      dir: '.',
      agentId: 'code',
      pinned: true,
    })
  }
  finally {
    await store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('thread usage is aggregated from independent Turn usage facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-turn-usage-`))
  const context = await createSqliteStore(root)

  try {
    await context.store.threads.upsert({ id: 'thread_usage', dir: '.', agentId: 'code' })

    for (const [id, input] of [['turn_1', 10], ['turn_2', 20]] as const) {
      await context.store.turns.create({
        id,
        threadId: 'thread_usage',
        status: 'completed',
        modelConfig: { id: 'test/model' },
        subagentRole: testSubagentRole,
        subagentRoles: testSubagentRoles,
        agentSnapshot: { id: 'code', systemPrompt: '' },
        approvalMode: 'request',
        subagentMode: 'explicitOnly',
      })
      const step = await context.store.steps.create({
        turnId: id,
        input,
        estimated: 0,
      })
      await context.store.steps.settle(step.id, {
        status: 'completed',
        input,
        output: 0,
        reasoning: 0,
        cacheWrite: 0,
        cacheRead: 0,
        estimated: 0,
      })
    }

    expect(await context.store.turns.listUsage()).toEqual([{
      threadId: 'thread_usage',
      usage: createTokenUsage({ input: 30 }),
    }])
  }
  finally {
    await context.store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('SQL usage aggregation preserves per-Step caps, empty Turns and transaction rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-usage-query-`))
  const { store } = await createSqliteStore(root)
  const client = new DatabaseSync(path.join(root, 'sqlite-db/store.db'))

  try {
    await store.threads.upsert({ id: 'thread_usage_query', dir: '.', agentId: 'code' })
    await createQueryTurn(store, 'thread_usage_query', 'turn_empty')
    await createQueryTurn(store, 'thread_usage_query', 'turn_usage')
    await store.threads.upsert({ id: 'thread_unrelated', dir: '.', agentId: 'code' })
    await createQueryTurn(store, 'thread_unrelated', 'turn_unrelated')
    await store.steps.create({ turnId: 'turn_unrelated', input: 999, estimated: 999 })
    const first = await store.steps.create({ turnId: 'turn_usage', input: 10, estimated: 10 })
    const second = await store.steps.create({ turnId: 'turn_usage', input: 100, estimated: 0 })

    // 数据库约束只要求非负，模拟保留数据中超过子项上限的值，必须逐 Step 截断后求和
    client.prepare(`UPDATE steps
      SET output = 2, reasoning = 20, cache_write = 20, cache_read = 20, estimated = 50
      WHERE id = ?`).run(first.id)
    await store.steps.settle(second.id, {
      status: 'completed',
      input: 100,
      output: 20,
      reasoning: 1,
      cacheWrite: 0,
      cacheRead: 0,
      estimated: 0,
    })
    const expected = createTokenUsage({
      input: 110,
      output: 22,
      reasoning: 3,
      cacheWrite: 10,
      cacheRead: 10,
      estimated: 12,
    })
    const queries = vi.spyOn(NodeSQLiteSession.prototype, 'prepareQuery')

    try {
      const turns = await store.turns.list('thread_usage_query')

      expect(turns.map(turn => turn.usage)).toEqual([createTokenUsage(), expected])
      const statements = queries.mock.calls.map(([query]) => query.sql)

      expect(statements).toHaveLength(2)
      expect(statements[1]).toContain('group by "steps"."turn_id"')
      expect(statements[1]).not.toContain('"steps"."status"')
    }
    finally {
      queries.mockRestore()
    }

    expect((await store.turns.read('turn_usage'))?.usage).toEqual(expected)
    expect((await store.turns.readLatest('thread_usage_query'))?.usage).toEqual(expected)
    expect((await store.turns.page({ threadId: 'thread_usage_query', limit: 1 })).turns[0]?.usage).toEqual(expected)
    expect(await store.turns.listUsage()).toContainEqual({ threadId: 'thread_usage_query', usage: expected })
    expect(await store.turns.list('missing_thread')).toEqual([])
    await expect(store.transaction(async (tx) => {
      await tx.steps.create({ turnId: 'turn_usage', input: 7, estimated: 7 })
      expect((await tx.turns.read('turn_usage'))?.usage.input).toBe(117)
      throw new Error('rollback usage')
    })).rejects.toThrow('rollback usage')
    expect((await store.turns.read('turn_usage'))?.usage).toEqual(expected)

    await store.close()
    const reopened = await createSqliteStore(root)

    try {
      expect((await reopened.store.turns.read('turn_usage'))?.usage).toEqual(expected)
    }
    finally {
      await reopened.store.close()
    }
  }
  finally {
    client.close()
    await store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('latest child Turns are selected in SQL within derived Turns with stable ordering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-child-query-`))
  const { store } = await createSqliteStore(root)
  const early = '2026-01-01T00:00:00.000Z'
  const late = '2026-01-02T00:00:00.000Z'

  try {
    for (const id of ['parent', 'other_parent', 'child_a', 'child_b', 'child_empty', 'child_other'])
      await store.threads.upsert({ id, dir: '.', agentId: 'code' })
    await createQueryTurn(store, 'parent', 'parent_turn')
    for (const [childThreadId, parentThreadId, createdAt] of [
      ['child_a', 'parent', late],
      ['child_b', 'parent', early],
      ['child_empty', 'parent', early],
      ['child_other', 'other_parent', early],
    ] as const) {
      await store.spawnEdges.create({ childThreadId, parentThreadId, ownerId: 'subagent', createdAt })
    }
    // 后插入更早的记录，验证选择依据时间与 ID，而非插入顺序
    for (const [threadId, id, createdAt, derived] of [
      ['child_a', 'turn_a_z', late, true],
      ['child_a', 'turn_a_a', late, true],
      ['child_a', 'turn_a_old', early, true],
      ['child_b', 'turn_b', early, true],
      ['child_other', 'turn_other', late, true],
      ['child_a', 'turn_a_ordinary', '2026-01-03T00:00:00.000Z', false],
      ['child_empty', 'turn_empty_child', late, false],
    ] as const) {
      await createQueryTurn(store, threadId, id, createdAt)
      if (!derived)
        continue
      const message = createTextTranscript({
        id: `msg_${id}`,
        threadId: 'parent',
        turnId: 'parent_turn',
        role: 'assistant',
        text: 'spawn',
      })

      await store.transcript.upsert(message)
      const tool = await store.toolCalls.create({
        turnId: 'parent_turn',
        assistantMessageId: message.id,
        assistantPartId: message.parts[0]!.id,
        providerCallId: `call_${id}`,
        name: 'subagent',
        args: {},
      })

      await store.turnSpawnEdges.create({ childTurnId: id, parentToolCallId: tool.id })
    }
    await store.steps.create({ turnId: 'turn_a_z', input: 12, estimated: 12 })
    await store.steps.create({ turnId: 'turn_a_old', input: 999, estimated: 999 })
    const queries = vi.spyOn(NodeSQLiteSession.prototype, 'prepareQuery')

    try {
      const children = await store.spawnEdges.listChildrenWithLatestTurn('parent')

      expect(children.map(child => [child.thread.id, child.turn.id, child.turn.usage.input])).toEqual([
        ['child_b', 'turn_b', 0],
        ['child_a', 'turn_a_z', 12],
      ])
      const statements = queries.mock.calls.map(([query]) => query.sql)

      expect(statements).toHaveLength(2)
      expect(statements[0]).toContain('not exists')
      expect(statements[0]).toContain('newer_child_turn_edge')
      for (const child of children) {
        expect(await store.turnSpawnEdges.readByChildTurn(child.turn.id))
          .toMatchObject({ parentToolCallId: child.parentToolCallId })
      }
    }
    finally {
      queries.mockRestore()
    }
    expect(await store.spawnEdges.listChildrenWithLatestTurn('missing_parent')).toEqual([])
    expect((await store.spawnEdges.listChildrenWithLatestTurn('other_parent')).map(child => child.turn.id))
      .toEqual(['turn_other'])
    await store.transaction(async (tx) => {
      await tx.threads.remove('child_a')
      expect((await tx.spawnEdges.listChildrenWithLatestTurn('parent')).map(child => child.thread.id))
        .toEqual(['child_b'])
    })
    expect((await store.spawnEdges.listChildrenWithLatestTurn('parent')).map(child => child.thread.id))
      .toEqual(['child_b'])
  }
  finally {
    await store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('turn lifecycle preserves queued and cancelled timestamps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-turn-lifecycle-`))
  const context = await createSqliteStore(root)

  try {
    await context.store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread_turn_lifecycle' })
    const queued = await context.store.turns.create({
      id: 'turn_queued',
      threadId: 'thread_turn_lifecycle',
      status: 'queued',
      modelConfig: { id: 'test/model' },
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'request',
      subagentMode: 'explicitOnly',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(queued).toEqual({
      id: 'turn_queued',
      threadId: 'thread_turn_lifecycle',
      status: 'queued',
      modelConfig: { id: 'test/model' },
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'request',
      subagentMode: 'explicitOnly',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      errorMessage: null,
      usage: createTokenUsage(),
      interrupt: null,
    })

    const running = await context.store.turns.update(queued.id, {
      status: 'running',
      startedAt: '2026-01-01T00:00:01.000Z',
    })

    expect(running.startedAt).toBe('2026-01-01T00:00:01.000Z')
    expect(running.endedAt).toBeUndefined()
    expect(running.updatedAt.localeCompare(queued.updatedAt)).toBeGreaterThan(0)

    const cancelled = await context.store.turns.update(queued.id, {
      status: 'cancelled',
      endedAt: '2026-01-01T00:00:02.000Z',
    })

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.endedAt).toBe('2026-01-01T00:00:02.000Z')
    expect(cancelled.updatedAt.localeCompare(running.updatedAt)).toBeGreaterThan(0)
  }
  finally {
    await context.store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('turn ordering uses createdAt and id consistently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-turn-order-`))
  const context = await createSqliteStore(root)
  const threadId = 'thread_turn_order'
  const createdAt = '2026-01-01T00:00:00.000Z'
  const turnIds = [
    'turn_11111111-1111-4111-8111-111111111111',
    'turn_22222222-2222-4222-8222-222222222222',
  ]

  try {
    await context.store.threads.upsert({ id: threadId, dir: '.', agentId: 'code' })

    for (const [index, id] of turnIds.entries()) {
      await context.store.turns.create({
        id,
        threadId,
        status: index === 0 ? 'completed' : 'running',
        modelConfig: { id: 'model_11111111-1111-4111-8111-111111111111' },
        subagentRole: testSubagentRole,
        subagentRoles: testSubagentRoles,
        agentSnapshot: { id: 'code', systemPrompt: '' },
        approvalMode: 'request',
        subagentMode: 'explicitOnly',
        createdAt,
      })
    }

    const turns = await context.store.turns.list(threadId)
    const allTurns = (await context.store.turns.listAll())
      .filter(turn => turn.threadId === threadId)
    const latest = await context.store.turns.readLatest(threadId)

    expect(turns.map(turn => turn.id)).toEqual(turnIds)
    expect(allTurns.map(turn => turn.id)).toEqual(turnIds)
    expect(latest?.id).toBe(turnIds[1])
    expect(latest?.status).toBe('running')
  }
  finally {
    await context.store.close()
    await rm(root, { force: true, recursive: true })
  }
})

test('transcript pages preserve Turn boundaries with a stable keyset cursor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-store-transcript-page-`))
  const context = await createSqliteStore(root)
  const threadId = 'thread_11111111-1111-4111-8111-111111111111'
  const createdAt = '2026-01-01T00:00:00.000Z'
  const turnIds = [
    'turn_11111111-1111-4111-8111-111111111111',
    'turn_22222222-2222-4222-8222-222222222222',
    'turn_33333333-3333-4333-8333-333333333333',
    'turn_44444444-4444-4444-8444-444444444444',
  ]

  try {
    await context.store.threads.upsert({ dir: '.', agentId: 'code', id: threadId })

    for (const [index, id] of turnIds.entries()) {
      await context.store.turns.create({
        id,
        threadId,
        status: 'completed',
        modelConfig: { id: 'model_11111111-1111-4111-8111-111111111111' },
        subagentRole: testSubagentRole,
        subagentRoles: testSubagentRoles,
        agentSnapshot: { id: 'code', systemPrompt: '' },
        approvalMode: 'request',
        subagentMode: 'explicitOnly',
        createdAt,
      })
      const transcript = createTextTranscript({
        id: `msg_${index + 1}`,
        threadId,
        turnId: id,
        role: 'assistant',
        text: `第 ${index + 1} 个 Turn`,
      })

      await context.store.transcript.upsert(transcript)
    }

    const latest = await context.store.turns.page({ threadId, limit: 2 })
    const latestMessages = await context.store.transcript.list(
      threadId,
      latest.turns.map(turn => turn.id),
    )

    expect(latest.turns.map(turn => turn.id)).toEqual(turnIds.slice(2))
    expect(latestMessages.map(message => message.id)).toEqual(['msg_3', 'msg_4'])
    expect(latestMessages.flatMap(message => message.parts).map(part => (
      part.type === 'text' ? part.text : undefined
    ))).toEqual(['第 3 个 Turn', '第 4 个 Turn'])
    expect(latest.nextCursor).toEqual({ createdAt, id: turnIds[2] })

    const earlier = await context.store.turns.page({
      threadId,
      cursor: latest.nextCursor,
      limit: 2,
    })
    const earlierMessages = await context.store.transcript.list(
      threadId,
      earlier.turns.map(turn => turn.id),
    )

    expect(earlier.turns.map(turn => turn.id)).toEqual(turnIds.slice(0, 2))
    expect(earlierMessages.map(message => message.id)).toEqual(['msg_1', 'msg_2'])
    expect(earlierMessages.flatMap(message => message.parts).map(part => (
      part.type === 'text' ? part.text : undefined
    ))).toEqual(['第 1 个 Turn', '第 2 个 Turn'])
    expect(earlier.nextCursor).toBeUndefined()
  }
  finally {
    await context.store.close()
    await rm(root, { force: true, recursive: true })
  }
})

/** -------------------- 内部函数 -------------------- */
/**
 * 执行 RuntimeStore 统一契约测试
 */
async function runStoreContract(store: RuntimeStore, blobStore: BlobStore) {
  const thread = await store.threads.upsert({
    dir: '.',
    agentId: 'code',
    id: 'thread_contract',
    userTitle: 'RuntimeStore Contract',
    metadata: { source: 'contract' },
  })
  const unreadAt = '2026-01-01T00:00:00.000Z'

  expect(thread.unreadAt).toBeNull()
  await store.threads.upsert({ id: thread.id, unreadAt })
  const turn = await store.turns.create({
    id: 'turn_contract',
    threadId: thread.id,
    status: 'running',
    modelConfig: {
      id: 'test/qwen3.6-flash',
      apiFormat: 'anthropic-messages',
      baseURL: 'https://example.com/anthropic',
      cache: { mode: 'disabled' },
      limit: { context: 200_000 },
      jsonSchema: true,
      inputModalities: [],
    },
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
  })
  const createdAt = '2026-01-01T00:00:00.000Z'
  const userMessage: ThreadMessage = {
    ...createTextTranscript({
      id: 'msg_user',
      threadId: thread.id,
      turnId: turn.id,
      role: 'user',
      text: 'hello store',
      createdAt,
    }),
    parts: [{
      id: 'part_user_text',
      messageId: 'msg_user',
      threadId: thread.id,
      turnId: turn.id,
      seq: 1,
      type: 'text',
      status: 'completed',
      text: 'hello store',
      createdAt,
      updatedAt: createdAt,
    }, {
      id: 'part_user_mention',
      messageId: 'msg_user',
      threadId: thread.id,
      turnId: turn.id,
      seq: 2,
      type: 'mention',
      status: 'completed',
      pluginId: 'skill',
      resourceId: 'skill_chrome',
      trigger: '$',
      label: 'Chrome',
      data: { source: 'user', origin: { type: 'external' as const, id: 'codex' as const } },
      createdAt,
      updatedAt: createdAt,
    }],
  }
  const assistantMessage: ThreadMessage = {
    id: 'msg_assistant',
    threadId: thread.id,
    turnId: turn.id,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    parts: [{
      id: 'part_tool',
      messageId: 'msg_assistant',
      threadId: thread.id,
      turnId: turn.id,
      seq: 1,
      type: 'tool',
      status: 'running',
      toolName: 'shell',
      createdAt,
      updatedAt: createdAt,
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  }

  await store.transcript.upsert(userMessage)
  await store.transcript.upsert(assistantMessage)
  const toolCall = await store.toolCalls.create({
    id: 'tool_contract',
    turnId: turn.id,
    assistantMessageId: assistantMessage.id,
    assistantPartId: assistantMessage.parts[0]!.id,
    providerCallId: 'toolu_contract',
    name: 'shell',
    args: { command: 'pwd' },
  })
  const childThread = await store.threads.upsert({
    dir: '.',
    agentId: 'code',
    id: 'thread_child_contract',
    userTitle: 'Child Thread',
  })
  const childTurn = await store.turns.create({
    id: 'turn_child_contract',
    threadId: childThread.id,
    status: 'queued',
    modelConfig: turn.modelConfig,
    subagentRole: testSubagentRole,
    subagentRoles: [],
    agentSnapshot: turn.agentSnapshot,
    approvalMode: turn.approvalMode,
    subagentMode: turn.subagentMode,
  })
  const spawnEdge = await store.spawnEdges.create({
    childThreadId: childThread.id,
    ownerId: 'subagent',
    parentThreadId: thread.id,
  })
  const turnSpawnEdge = await store.turnSpawnEdges.create({
    childTurnId: childTurn.id,
    parentToolCallId: toolCall.id,
  })

  assistantMessage.status = 'interrupted'
  const userText = userMessage.parts[0]

  if (userText?.type !== 'text')
    throw new TypeError('用户消息缺少文本 Part')
  userMessage.parts[0] = { ...userText, text: 'hello updated store' }
  await store.transcript.upsert(assistantMessage)
  await store.transcript.upsert(userMessage)
  await store.turns.update(turn.id, {
    status: 'interrupted',
    interrupt: { id: 'interrupt_contract', kind: 'system' },
  })
  const step = await store.steps.create({
    turnId: turn.id,
    input: 1,
    estimated: 1,
  })
  await store.steps.settle(step.id, {
    status: 'interrupted',
    input: 1,
    output: 0,
    reasoning: 0,
    cacheWrite: 0,
    cacheRead: 0,
    estimated: 1,
  })
  await store.toolCalls.update(toolCall.id, {
    status: 'running',
    decision: 'approve',
    startedAt: '2026-01-01T00:00:00.000Z',
  })

  await store.threads.upsert({
    dir: '.',
    agentId: 'code',
    id: thread.id,
    state: { phase: 'streaming_model' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  await store.threads.upsert({
    dir: '.',
    agentId: 'code',
    id: thread.id,
    state: { phase: 'awaiting_approval' },
    updatedAt: '2026-01-01T00:00:01.000Z',
  })

  const inlineArtifact = await store.artifacts.write({
    threadId: thread.id,
    contentKind: 'text',
    contentText: 'short',
  })
  const blobArtifact = await store.artifacts.write({
    id: 'artifact_11111111-1111-4111-8111-111111111111',
    threadId: thread.id,
    contentKind: 'text',
    contentText: largeArtifactContent,
  })
  const longLineArtifact = await store.artifacts.write({
    id: 'artifact_22222222-2222-4222-8222-222222222222',
    threadId: thread.id,
    contentKind: 'text',
    contentText: 'x'.repeat(10_000),
  })
  await store.transaction(async (tx) => {
    await tx.threads.upsert({ dir: '.', agentId: 'code', id: 'thread_tx', userTitle: 'Transaction Thread' })
  })

  expect((await store.threads.read(thread.id))?.metadata).toEqual({ source: 'contract' })
  expect((await store.threads.read(thread.id))?.unreadAt).toBe(unreadAt)
  expect((await store.threads.read('thread_tx'))?.title).toBe('Transaction Thread')
  const transcript = await store.transcript.list(thread.id)

  expect(transcript).toHaveLength(2)
  expect(transcript[0]?.parts[0]).toMatchObject({ text: 'hello updated store' })
  expect(transcript[0]?.parts.find(item => item.id === 'part_user_mention'))
    .toMatchObject({
      type: 'mention',
      pluginId: 'skill',
      resourceId: 'skill_chrome',
      trigger: '$',
      label: 'Chrome',
      data: { source: 'user', origin: { type: 'external' as const, id: 'codex' as const } },
    })
  expect((await store.turns.list(thread.id))[0]?.status).toBe('interrupted')
  expect((await store.turns.list(thread.id))[0]?.interrupt).toEqual({
    id: 'interrupt_contract',
    kind: 'system',
  })
  expect((await store.turns.list(thread.id))[0]?.modelConfig).toMatchObject({
    id: 'test/qwen3.6-flash',
    limit: { context: 200_000 },
  })
  expect((await store.turns.readLatest(thread.id))?.id).toBe(turn.id)
  expect(await store.turns.listUsage()).toEqual(expect.arrayContaining([{
    threadId: thread.id,
    usage: expect.objectContaining({
      input: 1,
      estimated: 1,
      total: 1,
    }),
  }]))
  expect((await store.turns.read(childTurn.id))?.subagentRole).toEqual(testSubagentRole)
  expect((await store.toolCalls.list({ turnId: turn.id }))[0]).toMatchObject({
    assistantMessageId: assistantMessage.id,
    assistantPartId: assistantMessage.parts[0]!.id,
    decision: 'approve',
  })
  expect(await store.spawnEdges.readByChild(childThread.id)).toEqual(spawnEdge)
  expect(await store.spawnEdges.listChildren(thread.id)).toEqual([spawnEdge])
  expect(await store.spawnEdges.listChildrenWithLatestTurn(thread.id)).toEqual([{
    ownerId: 'subagent',
    thread: childThread,
    turn: childTurn,
    parentToolCallId: toolCall.id,
  }])
  expect(await store.turnSpawnEdges.readByChildTurn(childTurn.id)).toEqual(turnSpawnEdge)
  expect(await store.turnSpawnEdges.readByParentToolCall(toolCall.id)).toEqual(turnSpawnEdge)
  expect(await store.turnSpawnEdges.listChildren(turn.id)).toEqual([turnSpawnEdge])
  expect((await store.threads.read(thread.id))?.state).toEqual({ phase: 'awaiting_approval' })
  expect(inlineArtifact.id).toMatch(
    /^artifact_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  expect(inlineArtifact.storage).toBe('inline')
  expect((await store.artifacts.readText(inlineArtifact.id))?.content).toBe('short')
  expect((await store.artifacts.readText(longLineArtifact.id))?.content.replaceAll('\n', ''))
    .toBe('x'.repeat(10_000))
  expect(blobArtifact.storage).toBe('blob')
  expect(blobArtifact.blobKey).toBeTypeOf('string')
  const firstBlobPage = await store.artifacts.readText(blobArtifact.id)

  expect(firstBlobPage).toMatchObject({
    lineStart: 1,
    lineEnd: 506,
    totalLines: 3_000,
    truncated: true,
  })
  expect(Buffer.byteLength(firstBlobPage?.content ?? '', 'utf8'))
    .toBeLessThanOrEqual(50 * 1024)
  expect(await store.artifacts.readText(blobArtifact.id, {
    offset: firstBlobPage?.lineEnd,
    limit: 10,
  }))
    .toMatchObject({
      lineStart: (firstBlobPage?.lineEnd ?? 0) + 1,
      lineEnd: (firstBlobPage?.lineEnd ?? 0) + 10,
      totalLines: 3_000,
      truncated: true,
    })
  expect(Buffer.from(await blobStore.read(blobArtifact.blobKey ?? '')).toString('utf8'))
    .toBe(largeArtifactContent)
  expect((await store.artifacts.markMissing(inlineArtifact.id))?.state)
    .toBe('missing')

  await store.threads.upsert({ id: thread.id, unreadAt: null })
  expect((await store.threads.read(thread.id))?.unreadAt).toBeNull()

  await store.threads.remove(thread.id)

  expect(await store.transcript.list(thread.id)).toEqual([])
  expect(await store.turns.list(thread.id)).toEqual([])
  expect(await store.toolCalls.list({ threadId: thread.id })).toEqual([])
  expect(await store.spawnEdges.readByChild(childThread.id)).toBeUndefined()
  expect(await store.turnSpawnEdges.readByChildTurn(childTurn.id)).toBeUndefined()
  expect(await store.threads.read(thread.id)).toBeUndefined()
}

/**
 * 创建单文本 UI transcript 消息
 */
function createTextTranscript(input: {
  /** 消息 ID */
  id: string
  /** 线程 ID */
  threadId: string
  /** Turn ID */
  turnId: string
  /** 消息角色 */
  role: ThreadMessage['role']
  /** 文本内容 */
  text: string
  /** 创建时间 */
  createdAt?: string
}): ThreadMessage {
  const createdAt = input.createdAt ?? '2026-01-01T00:00:00.000Z'
  const partId = `${input.id}:text`

  return {
    id: input.id,
    threadId: input.threadId,
    turnId: input.turnId,
    role: input.role,
    kind: 'normal',
    status: 'completed',
    parts: [{
      id: partId,
      messageId: input.id,
      threadId: input.threadId,
      turnId: input.turnId,
      seq: 1,
      type: 'text',
      status: 'completed',
      text: input.text,
      createdAt,
      updatedAt: createdAt,
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  }
}

/**
 * 创建 SQLite RuntimeStore contract 上下文
 */
async function createSqliteStore(root: string) {
  const blobStore = LocalBlobStore.create({
    files: testFiles,
    rootDir: path.join(root, 'sqlite-blobs'),
  })
  const store = await SqliteStore.create({
    dataDir: path.join(root, 'sqlite-db'),
    blobStore,
  })

  return { blobStore, store }
}

/**
 * 创建查询回归测试所需的冻结 Turn
 */
function createQueryTurn(store: RuntimeStoreTx, threadId: string, id: string, createdAt = '2026-01-01T00:00:00.000Z') {
  return store.turns.create({
    id,
    threadId,
    status: 'completed',
    modelConfig: { id: 'test/model' },
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
    createdAt,
  })
}
