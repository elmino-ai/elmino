/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { RuntimeStore } from '@elmino/store'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { sqliteStore, SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { createBlobStore, verifyBlobStore } from '../store/support'

const blobs = createBlobStore(path.resolve('blobs'))
const content = await verifyBlobStore(blobs)
const options = { dataDir: path.resolve('database'), blobStore: blobs }
let store: RuntimeStore = await SqliteStore.create(options)
try {
  const thread = await store.threads.upsert({
    id: 'thread_package',
    agentId: 'agent_package',
    dir: '.',
  })
  const artifact = await store.artifacts.write({
    threadId: thread.id,
    contentKind: 'text',
    contentText: 'installed database',
  })
  const binary = await store.artifacts.write({
    threadId: thread.id,
    contentKind: 'bytes',
    contentBytes: content,
  })
  if (binary.storage !== 'blob' || !binary.blobKey || !await blobs.exists(binary.blobKey))
    throw new Error('数据库未引用注入的内容存储')
  const failure = new Error('expected rollback')
  try {
    await store.transaction(async (tx) => {
      await tx.threads.upsert({ id: thread.id, pinned: true })
      throw failure
    })
    throw new Error('失败事务未拒绝')
  }
  catch (error) {
    if (error !== failure)
      throw error
  }
  if ((await store.threads.read(thread.id))?.pinned)
    throw new Error('失败事务未回滚')
  await store.close()
  store = await SqliteStore.create(options)
  if ((await store.artifacts.readText(artifact.id))?.content !== 'installed database')
    throw new Error('数据库重开后未保留正文')
  if ((await store.artifacts.read(binary.id))?.blobKey !== binary.blobKey)
    throw new Error('数据库重开后未保留内容引用')
}
finally { await store.close() }

const configured = sqliteStore({ dataDir: path.resolve('configured') })
const first = await configured()
let savedId: string
try {
  await first.store.threads.upsert({ id: 'thread_config', agentId: 'configured', dir: '.' })
  const artifact = await first.store.artifacts.write({
    threadId: 'thread_config',
    contentKind: 'bytes',
    contentBytes: content,
  })
  savedId = artifact.id
}
finally { await first.release() }
const reopened = await configured()
try {
  const artifact = await reopened.store.artifacts.read(savedId)
  assert.ok(artifact?.blobKey)
  const local = LocalBlobStore.create({ rootDir: path.resolve('configured/blobs') })
  assert.deepEqual(Array.from(await local.read(artifact.blobKey)), Array.from(content))
}
finally { await reopened.release() }

// 消费者可以只传环境变量，也可以完全不传目录；验收目录归独立临时项目所有
const originalDataDir = process.env.ELMINO_DATA_DIR
try {
  delete process.env.ELMINO_DATA_DIR
  const defaults = await sqliteStore()()
  try {
    await access(path.resolve('.elmino/database/store.db'))
  }
  finally { await defaults.release() }
}
finally {
  if (originalDataDir === undefined)
    delete process.env.ELMINO_DATA_DIR
  else
    process.env.ELMINO_DATA_DIR = originalDataDir
}
