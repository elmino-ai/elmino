import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { expect, test } from 'vitest'
import { migrateRuntimeStore } from '../src/drizzle/index.js'

/** -------------------- 常量 -------------------- */
/** RuntimeStore 迁移后的全部业务表 */
const runtimeTableNames = [
  'artifacts',
  'canonical_messages',
  'canonical_parts',
  'steps',
  'thread_spawn_edges',
  'threads',
  'tool_calls',
  'transcript_messages',
  'turn_spawn_edges',
  'turns',
]

/** -------------------- 测试 -------------------- */
test('runtime migrations create the current schema and preserve data idempotently', async () => {
  const context = await createTestDatabase()

  try {
    migrateRuntimeStore(context.db)

    const tables = await context.db.all<{ name: string }>(sql.raw(`
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT GLOB 'sqlite_*'
  AND name <> '__drizzle_migrations'
ORDER BY name
`))
    const [foreignKeys] = await context.db.all<{ foreign_keys: number }>(
      sql.raw('PRAGMA foreign_keys'),
    )
    const artifactColumns = await context.db.all<{ name: string }>(
      sql.raw('PRAGMA table_info(artifacts)'),
    )
    const turnColumns = await context.db.all<{ name: string }>(
      sql.raw('PRAGMA table_info(turns)'),
    )
    const spawnEdgeColumns = await context.db.all<{ name: string }>(
      sql.raw('PRAGMA table_info(thread_spawn_edges)'),
    )
    const toolCallColumns = await context.db.all<{ name: string }>(
      sql.raw('PRAGMA table_info(tool_calls)'),
    )
    const canonicalPartColumns = await context.db.all<{ name: string }>(
      sql.raw('PRAGMA table_info(canonical_parts)'),
    )

    expect(tables.map(table => table.name)).toEqual(runtimeTableNames)
    expect(foreignKeys?.foreign_keys).toBe(1)
    expect(artifactColumns.map(column => column.name)).not.toContain('kind')
    expect(turnColumns.map(column => column.name)).toContain('updated_at')
    expect(spawnEdgeColumns.map(column => column.name)).toContain('owner_id')
    expect(toolCallColumns.map(column => column.name)).toContain('assistant_message_id')
    expect(toolCallColumns.map(column => column.name)).toContain('result_part_id')
    expect(toolCallColumns.map(column => column.name)).not.toContain('output')
    expect(canonicalPartColumns.map(column => column.name)).toContain('content_blob')

    await context.db.run(sql.raw(`
INSERT INTO threads (
  id,
  dir,
  agent_id,
  status,
  pinned,
  created_at,
  updated_at,
  last_interaction_at,
  settings_json
) VALUES (
  'thread_preserved',
  '.',
  'code',
  'idle',
  FALSE,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '{}'
)
`))
    await context.db.run(sql.raw(`
INSERT INTO turns (
  id,
  thread_id,
  status,
  model_config_json,
  subagent_role_json,
  subagent_roles_json,
  agent_snapshot_json,
  approval_mode,
  subagent_mode,
  created_at,
  updated_at
) VALUES (
  'turn_preserved',
  'thread_preserved',
  'completed',
  '{}',
  'null',
  '[]',
  '{}',
  'auto',
  'explicitOnly',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
`))
    await context.db.run(sql.raw(`
INSERT INTO transcript_messages (
  id,
  thread_id,
  turn_id,
  seq,
  content_blob
) VALUES (
  'message_preserved',
  'thread_preserved',
  'turn_preserved',
  0,
  '{
    "id":"message_preserved",
    "threadId":"thread_preserved",
    "turnId":"turn_preserved",
    "role":"assistant",
    "kind":"normal",
    "status":"completed",
    "parts":[],
    "createdAt":"2026-01-01T00:00:00.000Z",
    "updatedAt":"2026-01-01T00:00:00.000Z",
    "metadata":{}
  }'
)
`))
    await context.db.run(sql.raw(`
INSERT INTO tool_calls (
  id,
  turn_id,
  assistant_message_id,
  assistant_part_id,
  provider_call_id,
  name,
  args_json,
  status
) VALUES (
  'tool_preserved',
  'turn_preserved',
  'message_preserved',
  'part_preserved',
  'provider_tool_preserved',
  'read',
  '{}',
  'completed'
)
`))
    await context.db.run(sql.raw(`
INSERT INTO artifacts (
  id,
  thread_id,
  storage,
  content_kind,
  inline_text,
  state,
  created_at,
  updated_at
) VALUES (
  'artifact_preserved',
  'thread_preserved',
  'inline',
  'text',
  'preserved',
  'available',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
`))

    migrateRuntimeStore(context.db)

    const preserved = await Promise.all([
      context.db.all<{ id: string }>(sql.raw('SELECT id FROM threads')),
      context.db.all<{ id: string }>(sql.raw('SELECT id FROM turns')),
      context.db.all<{ id: string }>(sql.raw('SELECT id FROM transcript_messages')),
      context.db.all<{ id: string }>(sql.raw('SELECT id FROM tool_calls')),
      context.db.all<{ id: string }>(sql.raw('SELECT id FROM artifacts')),
    ])
    const migrations = await context.db.all<{ hash: string }>(
      sql.raw('SELECT hash FROM __drizzle_migrations'),
    )

    expect(preserved).toEqual([
      [{ id: 'thread_preserved' }],
      [{ id: 'turn_preserved' }],
      [{ id: 'message_preserved' }],
      [{ id: 'tool_preserved' }],
      [{ id: 'artifact_preserved' }],
    ])
    expect(migrations).toHaveLength(1)
  }
  finally {
    context.client.close()
    await rm(context.root, { force: true, recursive: true })
  }
})

test('runtime migrations reject an unversioned schema without deleting its data', async () => {
  const context = await createTestDatabase()

  try {
    await context.db.run(sql.raw('CREATE TABLE threads (id TEXT PRIMARY KEY)'))
    await context.db.run(sql.raw('INSERT INTO threads VALUES (\'legacy\')'))

    expect(() => migrateRuntimeStore(context.db)).toThrow()

    const rows = await context.db.all<{ id: string }>(
      sql.raw('SELECT id FROM threads'),
    )
    const tables = await context.db.all<{ name: string }>(sql.raw(`
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT GLOB 'sqlite_*'
  AND name <> '__drizzle_migrations'
ORDER BY name
`))

    expect(rows).toEqual([{ id: 'legacy' }])
    expect(tables).toEqual([{ name: 'threads' }])
  }
  finally {
    context.client.close()
    await rm(context.root, { force: true, recursive: true })
  }
})

/** -------------------- 内部函数 -------------------- */
/**
 * 创建独立文件数据库并绑定当前 RuntimeStore Schema
 */
async function createTestDatabase() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-store-migrations-'))
  const client = new DatabaseSync(path.join(root, 'store.db'))

  const db = drizzle({ client })

  return { client, db, root }
}
