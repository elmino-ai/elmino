import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { testFiles } from './support/files.js'
import { testSubagentRole, testSubagentRoles } from './support/subagent.js'

/** -------------------- 测试环境 -------------------- */
let root: string
let store: Awaited<ReturnType<typeof SqliteStore.create>>
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'elmino-search-store-'))
  const blobStore = LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') })
  store = await SqliteStore.create({ dataDir: path.join(root, 'db'), blobStore })
})
afterEach(async () => {
  await store.close()
  await rm(root, { recursive: true, force: true })
})

/** -------------------- 测试 -------------------- */
test('中文和英文忽略大小写搜索当前标题与正文，并裁剪命中附近的片段', async () => {
  const title = await seedSearchThread(store, { title: '部署方案 AbC' })
  const body = await seedSearchThread(store, { text: `${'前文'.repeat(300)}部署方案 ABC 后文` })
  await store.transcript.upsert({ ...body.message, role: 'assistant' })
  for (const query of ['部署方案', 'abc', 'ABC']) {
    const result = await store.threads.search('code', query, 51)
    expect(result.map(hit => hit.threadId).sort()).toEqual([title.threadId, body.threadId].sort())
    const hit = result.find(hit => hit.threadId === body.threadId)!
    expect(hit.snippet).toContain('部署方案 ABC')
    expect(hit.snippet.length).toBeLessThanOrEqual(240)
  }
  await store.threads.upsert({ id: title.threadId, autoTitle: '旧自动标题', userTitle: '新标题' })
  expect(await store.threads.search('code', '旧自动标题', 51)).toEqual([])
  expect(await store.threads.search('code', '新标题', 51)).toHaveLength(1)
})

test('特殊字符按字面匹配，不把 SQL 或通配符解释为搜索表达式', async () => {
  await seedSearchThread(store, { text: '价格 100% 文件 _test 引号 \' 双引号 " 反斜线 \\' })
  await seedSearchThread(store)
  for (const query of ['%', '_', '\'', '"', '\\'])
    expect(await store.threads.search('code', query, 51)).toHaveLength(1)
  expect(await store.threads.search('code', '\' OR 1=1 --', 51)).toEqual([])
})

test('排除归档、删除中、子聊天和其他 Agent，并只搜索普通文本消息', async () => {
  const parent = await seedSearchThread(store, { title: '目标' })
  const archived = await seedSearchThread(store, { title: '目标' })
  const deleting = await seedSearchThread(store, { title: '目标' })
  const child = await seedSearchThread(store, { title: '目标' })
  await seedSearchThread(store, { title: '目标', agentId: 'work' })
  await store.threads.upsert({ id: archived.threadId, archivedAt: '2026-09-10T00:00:00Z' })
  await store.threads.transitionLifecycle(deleting.threadId, 'active', 'deleting')
  await store.spawnEdges.create({ ownerId: 'subagent', parentThreadId: parent.threadId, childThreadId: child.threadId })
  for (const query of ['目标', '', '   '])
    expect((await store.threads.search('code', query, 51)).map(hit => hit.threadId)).toEqual([parent.threadId])
  for (const role of ['system', 'user', 'assistant'] as const) {
    const entry = await seedSearchThread(store, { text: '隐藏内容' })
    await store.transcript.upsert({ ...entry.message, role, kind: role === 'system' ? 'normal' : 'synthetic' })
  }
  const reasoning = await seedSearchThread(store)
  await store.transcript.upsert({
    ...reasoning.message,
    role: 'assistant',
    parts: [{ ...reasoning.message.parts[0]!, type: 'reasoning', text: '隐藏内容' }],
  })
  const tool = await seedSearchThread(store)
  await store.transcript.upsert({
    ...tool.message,
    role: 'assistant',
    parts: [{
      ...tool.message.parts[0]!,
      type: 'tool',
      toolName: 'shell',
      output: '隐藏内容',
    }],
  })
  expect(await store.threads.search('code', '隐藏内容', 51)).toEqual([])
})

test('同一聊天多条命中只返回一次，按最近互动排序并执行结果上限', async () => {
  const older = await seedSearchThread(store, { title: '命中', text: '命中', timestamp: '2026-09-01T00:00:00Z' })
  const newer = await seedSearchThread(store, { text: '命中', timestamp: '2026-09-02T00:00:00Z' })
  await store.transcript.upsert({
    ...newer.message,
    id: `${newer.message.id}:second`,
    parts: newer.message.parts.map(part => ({ ...part, messageId: `${newer.message.id}:second` })),
  })
  expect((await store.threads.search('code', '命中', 51)).map(hit => hit.threadId))
    .toEqual([newer.threadId, older.threadId])
  expect(await store.threads.search('code', '命中', 1)).toHaveLength(1)
  await store.threads.remove(newer.threadId)
  expect((await store.threads.search('code', '命中', 51)).map(hit => hit.threadId)).toEqual([older.threadId])
})

test('untitled threads preserve missing titles while body search still finds their text', async () => {
  const entry = await seedSearchThread(store, { text: 'search without a title' })
  await store.threads.upsert({ id: entry.threadId, userTitle: null, autoTitle: null })

  expect(await store.threads.read(entry.threadId)).not.toHaveProperty('title')
  const bodyHits = await store.threads.search('code', 'without', 10)
  const recentHits = await store.threads.search('code', '', 10)

  expect(bodyHits).toHaveLength(1)
  expect(bodyHits[0]).not.toHaveProperty('title')
  expect(bodyHits[0]?.snippet).toContain('without')
  expect(recentHits[0]).not.toHaveProperty('title')
})

test('空关键词返回最近会话，按互动时间排序并限制数量，不重复标题作为片段', async () => {
  const older = await seedSearchThread(store, { title: '较早', timestamp: '2026-09-01T00:00:00Z' })
  const newer = await seedSearchThread(store, { title: '最近', timestamp: '2026-09-02T00:00:00Z' })
  expect((await store.threads.search('code', '', 51)).map(hit => hit.threadId))
    .toEqual([newer.threadId, older.threadId])
  expect(await store.threads.search('code', '   ', 1)).toMatchObject([
    { threadId: newer.threadId, title: '最近', snippet: '' },
  ])
})

/** -------------------- 测试夹具 -------------------- */
/**
 * 为搜索测试创建完整的线程、Turn 与可修改消息事实
 */
async function seedSearchThread(store: RuntimeStore, input: {
  /** 展示标题 */
  title?: string
  /** 消息正文 */
  text?: string
  /** 所属 Agent */
  agentId?: string
  /** 最近互动时间 */
  timestamp?: string
} = {}) {
  const threadId = createId('thread')
  const turnId = createId('turn')
  const messageId = createId('message')
  const agentId = input.agentId ?? 'code'
  const timestamp = input.timestamp ?? '2026-09-10T00:00:00.000Z'
  await store.threads.upsert({
    id: threadId,
    dir: '.',
    agentId,
    userTitle: input.title ?? '普通聊天',
    lastInteractionAt: timestamp,
  })
  await store.turns.create({
    id: turnId,
    threadId,
    status: 'completed',
    modelConfig: {},
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: {},
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
  })
  const message: ThreadMessage = {
    id: messageId,
    threadId,
    turnId,
    role: 'user',
    kind: 'normal',
    status: 'completed',
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
    parts: [{
      id: `${messageId}:text`,
      messageId,
      threadId,
      turnId,
      seq: 1,
      type: 'text',
      text: input.text ?? '普通正文',
      status: 'completed',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }
  await store.transcript.upsert(message)
  return { threadId, turnId, message }
}
