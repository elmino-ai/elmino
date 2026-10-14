export const blobFixture = `
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BlobStore } from '@elmino/store'
import { LocalBlobStore } from '@elmino/store/local'
const blobs: BlobStore = LocalBlobStore.create({
  rootDir: path.resolve('blobs'),
  files: {
    async exists(file: string) {
      try { await access(file); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    async readBytes(file: string) { return new Uint8Array(await readFile(file)) },
    async writeBytes(file: string, bytes: Uint8Array) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, bytes)
      return {}
    },
  },
})
const content = new TextEncoder().encode('published artifact content')
const blob = await blobs.write(content)
if (!await blobs.exists(blob.blobKey)) throw new Error('文件内容没有落盘')
if (new TextDecoder().decode(await blobs.read(blob.blobKey)) !== 'published artifact content')
  throw new Error('文件内容无法回读')
if ((await blobs.write(content)).blobKey !== blob.blobKey) throw new Error('相同内容未复用')
`

/** 仓库外消费 SQLite 包，确认版本化迁移、事务和重开 */
export const sqliteFixture = `
${blobFixture}
import type { RuntimeStore } from '@elmino/store'
import { SqliteStore } from '@elmino/store-sqlite'
const options = { dataDir: path.resolve('database'), blobStore: blobs }
let store: RuntimeStore = await SqliteStore.create(options)
try {
  const thread = await store.threads.upsert({
    id: 'thread_package', agentId: 'agent_package', dir: '.',
  })
  const artifact = await store.artifacts.write({
    threadId: thread.id, contentKind: 'text', contentText: 'installed database',
  })
  const binary = await store.artifacts.write({
    threadId: thread.id, contentKind: 'bytes', contentBytes: content,
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
  catch (error) { if (error !== failure) throw error }
  if ((await store.threads.read(thread.id))?.pinned) throw new Error('失败事务未回滚')
  await store.close()
  store = await SqliteStore.create(options)
  if ((await store.artifacts.readText(artifact.id))?.content !== 'installed database')
    throw new Error('数据库重开后未保留正文')
  if ((await store.artifacts.read(binary.id))?.blobKey !== binary.blobKey)
    throw new Error('数据库重开后未保留内容引用')
}
finally { await store.close() }
`
