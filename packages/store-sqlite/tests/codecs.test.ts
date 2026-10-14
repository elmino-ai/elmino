import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrateRuntimeStore } from '../src/drizzle/migration/index.js'
import {
  canonicalMessages,
  canonicalParts,
  runtimeRelations,
  threads,
  transcriptMessages,
  turns,
} from '../src/drizzle/schema/index.js'

/** -------------------- 测试状态 -------------------- */
/** 使用真实迁移与默认 SQLite 映射，不引入测试专用列或 Codec */
let root = ''
let client: DatabaseSync
let db: ReturnType<typeof createDatabase>
/** 文本时间戳应原样返回，不应被转换成 Date */
const timestamp = '2026-09-09T12:34:56.789Z'

beforeEach(async () => {
  // 使用独立临时文件覆盖实际 Store 的列映射与连接生命周期
  root = await mkdtemp(path.join(os.tmpdir(), 'elmino-codecs-'))
  client = new DatabaseSync(path.join(root, 'store.db'))
  db = createDatabase(client)
  migrateRuntimeStore(db)
  await db.insert(threads).values({
    id: 'thread_codec',
    dir: '.',
    agent_id: 'code',
    status: 'idle',
    created_at: timestamp,
    updated_at: timestamp,
    last_interaction_at: timestamp,
    settings_json: '{}',
  })
  await db.insert(turns).values({
    id: 'turn_codec',
    thread_id: 'thread_codec',
    status: 'running',
    model_config_json: '{}',
    subagent_role_json: '{}',
    subagent_roles_json: '[]',
    agent_snapshot_json: '{}',
    approval_mode: 'request',
    subagent_mode: 'explicitOnly',
    created_at: timestamp,
    updated_at: timestamp,
  })
})

afterEach(async () => {
  client.close()
  await rm(root, { recursive: true, force: true })
})

/** -------------------- 测试 -------------------- */
test('runtime booleans encode as integers and decode consistently in transactions', async () => {
  expect((await db.select().from(threads))[0]?.pinned).toBe(false)
  expect(client.prepare('SELECT pinned FROM threads').all()[0]?.pinned).toBe(0)

  db.transaction((tx) => {
    const [updated] = tx.update(threads).set({ pinned: true }).returning().all()
    expect(updated?.pinned).toBe(true)
    expect(tx.select().from(threads).all()[0]?.pinned).toBe(true)
  })

  expect((await db.select().from(threads))[0]?.pinned).toBe(true)
  expect(client.prepare('SELECT pinned FROM threads').all()[0]?.pinned).toBe(1)

  expect(() => db.transaction((tx) => {
    tx.update(threads).set({ pinned: false }).run()
    expect(tx.select().from(threads).all()[0]?.pinned).toBe(false)
    throw new Error('rollback codec change')
  })).toThrow('rollback codec change')
  expect((await db.select().from(threads))[0]?.pinned).toBe(true)
})

test('nullable columns and JSON text preserve SQL null, JSON null and literal text separately', async () => {
  const metadata = '{ "中文": "😀\\n\\\"", "nested": [null, false, 0, ""] }'
  await db.update(threads).set({ metadata_json: metadata, user_title: '' })
  await db.update(turns).set({ interrupt_json: 'null' })
  const [thread] = await db.select().from(threads)
  const [turn] = await db.select().from(turns)

  // 当前 Schema 用普通 TEXT 保存 JSON，解析职责仍属于 Store；Codec 不能提前解析或重新序列化
  expect(thread).toMatchObject({
    metadata_json: metadata,
    settings_json: '{}',
    user_title: '',
    auto_title: null,
    unread_at: null,
    created_at: timestamp,
  })
  expect(turn).toMatchObject({ interrupt_json: 'null', error_message: null, ended_at: null })
  expect(typeof thread?.metadata_json).toBe('string')
  expect(JSON.parse(thread!.metadata_json)).toEqual({ 中文: '😀\n"', nested: [null, false, 0, ''] })

  await db.update(turns).set({ interrupt_json: null })
  expect((await db.select().from(turns))[0]?.interrupt_json).toBeNull()
  await expect(db.update(threads).set({ metadata_json: '{invalid' })).rejects.toThrow()
  expect((await db.select().from(threads))[0]?.metadata_json).toBe(metadata)
})

test.each([
  { name: 'empty', content: Buffer.alloc(0) },
  { name: 'binary', content: Buffer.from([0, 255, 128, 34, 92, 10, 195, 40]) },
  { name: 'unicode', content: Buffer.from('中文😀\u0000尾部', 'utf8') },
])('BLOB $name bytes survive ordinary, relational and transactional reads', async ({ content }) => {
  await db.insert(canonicalMessages).values({
    id: 'message_codec',
    thread_id: 'thread_codec',
    turn_id: 'turn_codec',
    seq: 1,
    role: 'user',
    created_at: timestamp,
  })
  db.transaction((tx) => {
    tx.insert(canonicalParts).values({
      id: 'part_codec',
      message_id: 'message_codec',
      seq: 1,
      type: 'text',
      size_bytes: content.byteLength,
      content_blob: content,
      created_at: timestamp,
    }).run()
    // 任意字节验证驱动的 Buffer 映射；此处不调用要求正文为 JSON 的 Store API
    const ordinary = tx.select().from(canonicalParts).orderBy(asc(canonicalParts.seq)).all()
    const related = tx.query.canonicalMessages.findFirst({
      where: { id: 'message_codec' },
      with: { parts: { orderBy: { seq: 'asc' } } },
    }).sync()
    expect(related?.parts).toEqual(ordinary)
    expect(related?.provider_id).toBeNull()
    expect(related?.metadata_json).toBe('{}')
    expect(Buffer.isBuffer(related?.parts[0]?.content_blob)).toBe(true)
    expect(related?.parts[0]?.content_blob).toEqual(content)
    expect(related?.parts[0]?.size_bytes).toBe(content.byteLength)
  })

  const ordinary = await db.select().from(canonicalParts).where(eq(canonicalParts.id, 'part_codec'))
  const related = await db.query.canonicalMessages.findFirst({
    where: { id: 'message_codec' },
    with: { parts: { orderBy: { seq: 'asc' } } },
  })
  expect(related?.parts).toEqual(ordinary)
  expect(Buffer.isBuffer(ordinary[0]?.content_blob)).toBe(true)
  expect(ordinary[0]?.content_blob).toEqual(content)
  expect(client.prepare(
    'SELECT typeof(content_blob) AS kind, length(content_blob) AS size FROM canonical_parts',
  ).all()[0])
    .toMatchObject({ kind: 'blob', size: content.byteLength })

  await db.insert(transcriptMessages).values({
    id: 'transcript_codec',
    thread_id: 'thread_codec',
    turn_id: 'turn_codec',
    seq: 1,
    content_blob: content,
  })
  const [transcript] = await db.select().from(transcriptMessages)
  expect(Buffer.isBuffer(transcript?.content_blob)).toBe(true)
  expect(transcript?.content_blob).toEqual(content)
})

/** -------------------- 内部函数 -------------------- */
/**
 * 使用生产关联定义创建默认驱动数据库
 */
function createDatabase(client: DatabaseSync) {
  return drizzle({ client, relations: runtimeRelations })
}
