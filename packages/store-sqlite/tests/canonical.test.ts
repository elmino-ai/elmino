import type { ThreadMessage } from '@elmino/store'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { NodeSQLiteSession } from 'drizzle-orm/node-sqlite/session'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { testFiles } from './support/files'
import { testSubagentRole, testSubagentRoles } from './support/subagent'

/** -------------------- 测试状态 -------------------- */
let root = ''
let store: Awaited<ReturnType<typeof SqliteStore.create>>

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'elmino-canonical-store-'))
  const blobStore = LocalBlobStore.create({
    files: testFiles,
    rootDir: path.join(root, 'blobs'),
  })

  store = await SqliteStore.create({
    dataDir: path.join(root, 'db'),
    blobStore,
  })
})

afterEach(async () => {
  await store.close()
  await rm(root, { force: true, recursive: true })
})

/** -------------------- 测试 -------------------- */
test('canonical message and BLOB parts round-trip without losing provider fields', async () => {
  await createThreadTurn('thread_canonical', 'turn_canonical')
  const largeText = `前缀-${'内容'.repeat(40_000)}-后缀`
  const message = await store.canonical.append({
    id: 'canonical_message_11111111-1111-4111-8111-111111111111',
    threadId: 'thread_canonical',
    turnId: 'turn_canonical',
    role: 'assistant',
    providerId: 'response_provider_private',
    finishReason: 'tool-calls',
    rawFinishReason: 'tool_use',
    metadata: { private: { encrypted: 'ciphertext' } },
    parts: [{
      id: 'canonical_part_11111111-1111-4111-8111-111111111111',
      type: 'reasoning',
      content: {
        type: 'reasoning',
        text: largeText,
        signature: 'provider-signature',
        metadata: { itemId: 'reasoning-item' },
      },
    }, {
      id: 'canonical_part_22222222-2222-4222-8222-222222222222',
      type: 'tool-call',
      content: {
        type: 'tool-call',
        id: 'call_provider',
        name: 'shell',
        args: { command: 'pwd', nested: { value: true } },
        metadata: { providerIndex: 3 },
      },
    }],
  })

  expect(message).toMatchObject({
    seq: 1,
    providerId: 'response_provider_private',
    rawFinishReason: 'tool_use',
    metadata: { private: { encrypted: 'ciphertext' } },
  })
  expect(message.parts[0]?.content).toMatchObject({
    text: largeText,
    signature: 'provider-signature',
  })
  expect(message.parts[1]?.content).toEqual({
    type: 'tool-call',
    id: 'call_provider',
    name: 'shell',
    args: { command: 'pwd', nested: { value: true } },
    metadata: { providerIndex: 3 },
  })

  const metadata = await store.canonical.listParts('thread_canonical')

  expect(metadata).toHaveLength(2)
  expect(metadata[0]).not.toHaveProperty('content')
  expect(metadata[0]?.sizeBytes).toBeGreaterThan(Buffer.byteLength(largeText))
})

test('canonical relation reads one ordered message while metadata queries exclude BLOB content', async () => {
  await createThreadTurn('thread_relation', 'turn_relation')
  const message = await store.canonical.append({
    threadId: 'thread_relation',
    turnId: 'turn_relation',
    role: 'user',
    parts: [{
      id: 'canonical_part_ffffffff-ffff-4fff-8fff-ffffffffffff',
      type: 'text',
      content: { type: 'text', text: '先写入' },
    }, {
      id: 'canonical_part_00000000-0000-4000-8000-000000000000',
      type: 'text',
      content: { type: 'text', text: '后写入' },
    }],
  })
  const queries = vi.spyOn(NodeSQLiteSession.prototype, 'prepareQuery')

  try {
    expect(await store.canonical.readMessage('thread_relation', message.id)).toEqual(message)
    expect(queries).toHaveBeenCalledTimes(1)
    expect(message.parts.map(part => part.seq)).toEqual([1, 2])
    expect(message.parts.map(part => part.content)).toEqual([
      { type: 'text', text: '先写入' },
      { type: 'text', text: '后写入' },
    ])
    expect(await store.canonical.readMessage('thread_other', message.id)).toBeUndefined()

    queries.mockClear()
    await store.canonical.list('thread_relation')
    await store.canonical.listParts('thread_relation')
    expect(queries).toHaveBeenCalledTimes(2)
    for (const [query] of queries.mock.calls)
      expect(query.sql).not.toContain('content_blob')
  }
  finally {
    queries.mockRestore()
  }
})

test('canonical relations read uncommitted parts on the transaction connection and roll back together', async () => {
  await createThreadTurn('thread_transaction', 'turn_transaction')
  const id = 'canonical_message_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  await expect(store.transaction(async (tx) => {
    const message = await tx.canonical.append({
      id,
      threadId: 'thread_transaction',
      turnId: 'turn_transaction',
      role: 'user',
      parts: [{ type: 'text', content: { type: 'text', text: '尚未提交' } }],
    })
    expect((await tx.canonical.readMessage('thread_transaction', id))?.parts).toEqual(message.parts)
    throw new Error('取消事务')
  })).rejects.toThrow('取消事务')

  expect(await store.canonical.readMessage('thread_transaction', id)).toBeUndefined()
  expect(await store.canonical.listParts('thread_transaction')).toEqual([])
  const empty = await store.canonical.append({
    id,
    threadId: 'thread_transaction',
    turnId: 'turn_transaction',
    role: 'user',
    parts: [],
  })
  expect(empty.seq).toBe(1)
  expect((await store.canonical.readMessage('thread_transaction', id))?.parts).toEqual([])
})

test('canonical part pages stay thread-scoped and continue by returned offset', async () => {
  await createThreadTurn('thread_owner', 'turn_owner')
  await createThreadTurn('thread_other', 'turn_other')
  const partId = 'canonical_part_33333333-3333-4333-8333-333333333333'

  await store.canonical.append({
    id: 'canonical_message_33333333-3333-4333-8333-333333333333',
    threadId: 'thread_owner',
    turnId: 'turn_owner',
    role: 'tool',
    parts: [{
      id: partId,
      type: 'tool-result',
      content: {
        type: 'tool-result',
        callId: 'call_structured',
        result: [{
          type: 'text',
          text: '😀结构化结果'.repeat(1_000),
        }],
      },
    }],
  })

  const first = await store.canonical.readPartPage('thread_owner', partId, {
    limit: 1_000,
  })
  const second = await store.canonical.readPartPage('thread_owner', partId, {
    offset: first?.nextOffset,
    limit: 1_000,
  })

  expect(Array.from(first?.content ?? '')).toHaveLength(1_000)
  expect(first?.nextOffset).toBe(1_000)
  expect(second?.offset).toBe(1_000)
  expect(await store.canonical.readPartPage('thread_other', partId))
    .toBeUndefined()
  expect((await store.canonical.readPart('thread_owner', partId))?.content)
    .toMatchObject({ callId: 'call_structured' })
})

test('concurrent canonical appends allocate unique committed thread order', async () => {
  await createThreadTurn('thread_concurrent', 'turn_concurrent')
  const messages = await Promise.all(Array.from({ length: 20 }, (_, index) => store.canonical.append({
    threadId: 'thread_concurrent',
    turnId: 'turn_concurrent',
    role: 'user',
    parts: [{ type: 'text', content: { text: String(index) } }],
  })))

  expect(messages.map(message => message.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  expect((await store.canonical.list('thread_concurrent')).map(message => message.id))
    .toEqual(messages.map(message => message.id))
})

test('canonical appendMany assigns stable thread order and range boundaries', async () => {
  await createThreadTurn('thread_order', 'turn_order')

  await store.canonical.appendMany(['first', 'second', 'third'].map((text, index) => ({
    id: `canonical_message_0000000${index + 1}-0000-4000-8000-00000000000${index + 1}`,
    threadId: 'thread_order',
    turnId: 'turn_order',
    role: 'user' as const,
    parts: [{
      id: `canonical_part_0000000${index + 1}-0000-4000-8000-00000000000${index + 1}`,
      type: 'text' as const,
      content: { type: 'text', text },
    }],
  })))

  expect((await store.canonical.list('thread_order')).map(item => item.seq))
    .toEqual([1, 2, 3])
  expect((await store.canonical.list('thread_order', {
    afterSeq: 1,
    throughSeq: 2,
  })).map(item => item.seq)).toEqual([2])
})

test('transcript remains an independent UI projection while canonical stores only provider facts', async () => {
  const threadId = 'thread_transcript'
  const turnId = 'turn_transcript'
  const transcript = createTranscriptMessage({
    id: 'msg_transcript',
    threadId,
    turnId,
    role: 'user',
    text: '用户可见消息',
  })
  const event = createTranscriptMessage({
    id: 'msg_event',
    threadId,
    turnId,
    role: 'system',
    text: '仅 UI 可见事件',
  })

  await createThreadTurn(threadId, turnId)
  await store.canonical.append({
    threadId,
    turnId,
    role: 'user',
    parts: [{
      type: 'text',
      content: { type: 'text', text: 'Provider 原文' },
    }],
  })
  await store.transcript.upsert(transcript)
  await store.transcript.upsert(event)
  const updatedTranscript = createTranscriptMessage({
    id: transcript.id,
    threadId,
    turnId,
    role: 'user',
    text: '用户可见消息（最终快照）',
  })

  await store.transcript.upsert(updatedTranscript)

  expect(await store.transcript.list(threadId)).toEqual([updatedTranscript, event])
  expect(await store.transcript.list(threadId, [turnId])).toEqual([updatedTranscript, event])
  expect(await store.transcript.list(threadId, [])).toEqual([])
  const [canonical] = await store.canonical.list(threadId)
  const storedMessage = await store.canonical.readMessage(threadId, canonical!.id)
  const parts = await store.canonical.listParts(threadId)

  expect(storedMessage?.parts.map(part => part.content)).toEqual([
    { type: 'text', text: 'Provider 原文' },
  ])
  expect(parts.map(part => part.type)).toEqual(['text'])

  await createThreadTurn('thread_transcript_other', 'turn_transcript_other')
  await expect(store.transcript.upsert({
    ...updatedTranscript,
    threadId: 'thread_transcript_other',
    turnId: 'turn_transcript_other',
    parts: updatedTranscript.parts.map(part => ({
      ...part,
      threadId: 'thread_transcript_other',
      turnId: 'turn_transcript_other',
    })),
  })).rejects.toThrow('Transcript 消息归属不可变更')
  expect(await store.transcript.list('thread_transcript_other')).toEqual([])
})

/** -------------------- 内部函数 -------------------- */
/**
 * 创建满足 Canonical 外键约束的线程和 Turn
 */
async function createThreadTurn(threadId: string, turnId: string) {
  await store.threads.upsert({ id: threadId, dir: '.', agentId: 'code' })
  await store.turns.create({
    id: turnId,
    threadId,
    status: 'running',
    modelConfig: { id: 'model_test' },
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
  })
}

/**
 * 创建 Canonical 测试使用的完成态 transcript 消息
 */
function createTranscriptMessage(input: {
  id: string
  threadId: string
  turnId: string
  role: 'system' | 'user'
  text: string
}): ThreadMessage {
  const timestamp = '2026-08-16T00:00:00.000Z'

  return {
    id: input.id,
    threadId: input.threadId,
    turnId: input.turnId,
    role: input.role,
    kind: 'normal',
    status: 'completed',
    parts: [{
      id: `${input.id}_part`,
      messageId: input.id,
      threadId: input.threadId,
      turnId: input.turnId,
      seq: 1,
      type: 'text',
      status: 'completed',
      text: input.text,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  }
}
