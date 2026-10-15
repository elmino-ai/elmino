/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { RuntimeStore } from '@elmino/store'
import path from 'node:path'
import { SqliteStore } from '@elmino/store-sqlite'
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
