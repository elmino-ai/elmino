import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { expect, onTestFinished, test, vi } from 'vitest'
import { testFiles } from './support/files.js'
import { testSubagentRole } from './support/subagent.js'

/** -------------------- 测试 -------------------- */
test.each(['read', 'readText'] as const)('artifact %s queues missing writes with transactions', async (method) => {
  const { store, options } = await createStoreContext()
  const thread = await store.threads.upsert({ id: 'thread_artifact', dir: '.', agentId: 'code' })
  const artifact = await store.artifacts.write({
    threadId: thread.id,
    contentKind: 'text',
    contentText: 'x'.repeat(300 * 1024),
  })
  const exists = vi.spyOn(options.blobStore, 'exists').mockResolvedValue(false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transaction = store.transaction(async (tx) => {
    await tx.threads.upsert({ id: thread.id, pinned: true })
    entered.resolve()
    await release.promise
  })

  await entered.promise
  const reading = store.artifacts[method](artifact.id)

  try {
    // 普通读取仍可获取已提交快照，附件检查不能在事务期间抢占写连接
    expect((await store.threads.read(thread.id))?.pinned).toBe(false)
    expect(exists).not.toHaveBeenCalled()
  }
  finally {
    release.resolve()
  }
  await Promise.all([transaction, reading])
  expect((await store.artifacts.read(artifact.id))?.state).toBe('missing')
  expect((await store.threads.read(thread.id))?.pinned).toBe(true)
})

test.each(['read', 'readText'] as const)('close drains artifact %s before closing its connection', async (method) => {
  const context = await createStoreContext()
  const { store, options } = context
  const thread = await store.threads.upsert({ id: 'thread_artifact_close', dir: '.', agentId: 'code' })
  const artifact = await store.artifacts.write({
    threadId: thread.id,
    contentKind: 'text',
    contentText: 'x'.repeat(300 * 1024),
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()

  const exists = vi.spyOn(options.blobStore, 'exists').mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return false
  })
  const reading = store.artifacts[method](artifact.id)

  await entered.promise
  const closing = store.close()
  const reopening = SqliteStore.create(options)

  try {
    await expect(store.artifacts[method](artifact.id)).rejects.toThrow('已经关闭')
  }
  finally {
    release.resolve()
  }
  await Promise.all([reading, closing])
  context.store = await reopening
  // 文件仍存在时不会触发缺失写回，避免新实例的检查掩盖旧实例写回失败
  exists.mockRestore()
  expect(await context.store.transaction(tx => tx.artifacts.read(artifact.id)))
    .toMatchObject({ state: 'missing', missingAt: expect.any(String) })
})

test('async transactions isolate uncommitted reads and release queued writes after rollback', async () => {
  const { store } = await createStoreContext()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error('rollback after await')
  const transaction = store.transaction(async (tx) => {
    await tx.threads.upsert({ id: 'thread_rollback', dir: '.', agentId: 'code' })
    entered.resolve()
    await release.promise
    expect(await tx.threads.read('thread_rollback')).toBeDefined()
    throw failure
  })
  const rejected = expect(transaction).rejects.toBe(failure)

  await entered.promise
  expect(await store.threads.read('thread_rollback')).toBeUndefined()
  const queued = store.threads.upsert({ id: 'thread_queued', dir: '.', agentId: 'code' })

  expect(await store.threads.read('thread_queued')).toBeUndefined()
  release.resolve()
  await rejected
  await queued
  expect(await store.threads.read('thread_rollback')).toBeUndefined()
  expect(await store.threads.read('thread_queued')).toBeDefined()
})

test('close waits for accepted writes, refuses new writes and permits a persistent reopen', async () => {
  const context = await createStoreContext()
  const { store, options } = context
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transaction = store.transaction(async (tx) => {
    await tx.threads.upsert({ id: 'thread_before_close', dir: '.', agentId: 'code' })
    entered.resolve()
    await release.promise
    // 关闭已经开始，事务内已接收的操作仍然必须能够完成
    await tx.threads.upsert({ id: 'thread_after_close', dir: '.', agentId: 'code' })
  })

  await entered.promise
  const queued = store.threads.upsert({ id: 'thread_queued_close', dir: '.', agentId: 'code' })
  const closing = store.close()

  expect(store.close()).toBe(closing)
  await expect(store.threads.upsert({ id: 'thread_rejected', dir: '.', agentId: 'code' })).rejects.toThrow('已经关闭')
  const reopening = SqliteStore.create(options)

  release.resolve()
  await Promise.all([transaction, queued, closing])
  const reopened = await reopening

  context.store = reopened
  expect(reopened).not.toBe(store)
  expect(await reopened.threads.read('thread_before_close')).toBeDefined()
  expect(await reopened.threads.read('thread_after_close')).toBeDefined()
  expect(await reopened.threads.read('thread_queued_close')).toBeDefined()
  expect(await reopened.threads.read('thread_rejected')).toBeUndefined()
})

test('close drains accepted Turn, canonical and spawn reads while rejecting new reads', async () => {
  const { store } = await createStoreContext()
  await store.threads.upsert({ id: 'thread_read_close', dir: '.', agentId: 'code' })
  await store.threads.upsert({ id: 'thread_read_child', dir: '.', agentId: 'code' })
  const turn = await store.turns.create({
    threadId: 'thread_read_close',
    modelConfig: {},
    subagentRole: testSubagentRole,
    subagentRoles: [],
    agentSnapshot: {},
    approvalMode: 'auto',
    subagentMode: 'explicitOnly',
  })
  const message = await store.canonical.append({
    threadId: turn.threadId,
    turnId: turn.id,
    role: 'user',
    parts: [{ type: 'text', content: { text: 'persistent read' } }],
  })
  const edge = await store.spawnEdges.create({
    parentThreadId: turn.threadId,
    childThreadId: 'thread_read_child',
    ownerId: 'subagent',
  })
  const reading = Promise.all([
    store.turns.read(turn.id),
    store.canonical.readMessage(turn.threadId, message.id),
    store.spawnEdges.listChildren(turn.threadId),
  ])
  const closing = store.close()

  await expect(store.turns.read(turn.id)).rejects.toThrow('已经关闭')
  await expect(store.canonical.readMessage(turn.threadId, message.id)).rejects.toThrow('已经关闭')
  await expect(store.spawnEdges.listChildren(turn.threadId)).rejects.toThrow('已经关闭')
  expect(await reading).toEqual([turn, message, [edge]])
  await closing
})

test('failed reads neither poison later writes nor prevent close from draining', async () => {
  const { store, options } = await createStoreContext()
  await store.threads.upsert({ id: 'thread_failed_read', dir: '.', agentId: 'code' })
  const turn = await store.turns.create({
    threadId: 'thread_failed_read',
    modelConfig: {},
    subagentRole: testSubagentRole,
    subagentRoles: [],
    agentSnapshot: {},
    approvalMode: 'auto',
    subagentMode: 'explicitOnly',
  })
  const failure = new Error('ordinary read failed')
  const preparing = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => {
    throw failure
  })
  const rejected = expect(store.turns.read(turn.id)).rejects.toThrow('Failed query')
  const queued = store.threads.upsert({ id: 'thread_after_read_failure', dir: '.', agentId: 'code' })
  const closing = store.close()

  try {
    await Promise.all([rejected, queued, closing])
  }
  finally {
    preparing.mockRestore()
  }
  const reopened = await SqliteStore.create(options)

  try {
    expect(await reopened.threads.read('thread_after_read_failure')).toBeDefined()
  }
  finally {
    await reopened.close()
  }
})

test('different BlobStore instances cannot silently replace an active file owner', async () => {
  const context = await createStoreContext()
  const replacement = LocalBlobStore.create({ files: testFiles, rootDir: path.join(context.root, 'blobs') })
  const options = { ...context.options, blobStore: replacement }

  await expect(SqliteStore.create(options)).rejects.toThrow('已经绑定其他 BlobStore')
  expect(await SqliteStore.create(context.options)).toBe(context.store)
  await context.store.threads.upsert({ id: 'thread_owner', dir: '.', agentId: 'code' })
  const artifact = await context.store.artifacts.write({
    id: 'artifact_owner',
    threadId: 'thread_owner',
    contentKind: 'bytes',
    contentBytes: new Uint8Array([1, 2, 3]),
  })
  const closing = context.store.close()
  const reopening = SqliteStore.create(options)

  await closing
  context.store = await reopening
  expect(await context.store.artifacts.read(artifact.id)).toMatchObject({ state: 'available' })
  expect(Array.from(await replacement.read(artifact.blobKey!))).toEqual([1, 2, 3])
})

test('concurrent opening rejects conflicting blob ownership and preserves the successful owner', async () => {
  const context = await createStoreContext()
  const dataDir = path.join(context.root, 'concurrent-db')
  const replacement = LocalBlobStore.create({ files: testFiles, rootDir: path.join(context.root, 'other-blobs') })
  const first = SqliteStore.create({ dataDir, blobStore: context.options.blobStore })
  const conflict = SqliteStore.create({ dataDir, blobStore: replacement })
  const rejected = expect(conflict).rejects.toThrow('已经绑定其他 BlobStore')
  const owner = await first

  try {
    await rejected
    expect(await SqliteStore.create({ dataDir, blobStore: context.options.blobStore })).toBe(owner)
    expect(await owner.threads.upsert({ id: 'thread_concurrent', dir: '.', agentId: 'code' })).toBeDefined()
  }
  finally {
    await owner.close()
  }
})

test('failed blob writes do not persist references or poison the write queue', async () => {
  const { store, options } = await createStoreContext()
  await store.threads.upsert({ id: 'thread_failed_blob', dir: '.', agentId: 'code' })
  const failure = new Error('external blob backend failed')
  const writing = vi.spyOn(options.blobStore, 'write').mockRejectedValueOnce(failure)
  const input = {
    id: 'artifact_failed_blob',
    threadId: 'thread_failed_blob',
    contentKind: 'bytes' as const,
    contentBytes: new Uint8Array([1]),
  }

  await expect(store.artifacts.write(input)).rejects.toBe(failure)
  expect(await store.artifacts.read(input.id)).toBeUndefined()
  writing.mockRestore()
  expect(await store.artifacts.write(input)).toMatchObject({ state: 'available', storage: 'blob' })
})

test('rollback removes database references while immutable blob content can remain', async () => {
  const { store, options } = await createStoreContext()
  let blobKey: string | undefined

  await expect(store.transaction(async (tx) => {
    await tx.threads.upsert({ id: 'thread_blob_rollback', dir: '.', agentId: 'code' })
    const artifact = await tx.artifacts.write({
      id: 'artifact_blob_rollback',
      threadId: 'thread_blob_rollback',
      contentKind: 'bytes',
      contentBytes: new Uint8Array([1, 2, 3]),
    })

    blobKey = artifact.blobKey ?? undefined
    throw new Error('rollback blob reference')
  })).rejects.toThrow('rollback blob reference')
  expect(await store.threads.read('thread_blob_rollback')).toBeUndefined()
  expect(await store.artifacts.read('artifact_blob_rollback')).toBeUndefined()
  expect(blobKey).toBeDefined()
  expect(Array.from(await options.blobStore.read(blobKey!))).toEqual([1, 2, 3])
})

test('writing skips read-side blob checks while transient read failures preserve artifact metadata', async () => {
  const { store, options } = await createStoreContext()
  await store.threads.upsert({ id: 'thread_blob_outage', dir: '.', agentId: 'code' })
  const outage = new Error('temporary backend outage')
  const checking = vi.spyOn(options.blobStore, 'exists').mockRejectedValueOnce(outage)
  const artifact = await store.artifacts.write({
    threadId: 'thread_blob_outage',
    contentKind: 'bytes',
    contentBytes: new Uint8Array([1]),
  })

  expect(checking).not.toHaveBeenCalled()
  await expect(store.artifacts.read(artifact.id)).rejects.toBe(outage)
  checking.mockRestore()
  expect(await store.artifacts.read(artifact.id)).toMatchObject({ state: 'available', missingAt: null })
})

test('opening an unversioned schema preserves its data and evicts the failed owner', async () => {
  const context = await createStoreContext()
  const dataDir = path.join(context.root, 'legacy-db')
  await mkdir(dataDir)
  const filename = path.join(dataDir, 'store.db')
  const legacy = new DatabaseSync(filename)
  legacy.exec('CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES (\'legacy\')')
  legacy.close()
  const options = { ...context.options, dataDir }

  await expect(SqliteStore.create(options)).rejects.toThrow()
  const inspecting = new DatabaseSync(filename)

  try {
    expect(inspecting.prepare('SELECT id FROM threads').all()).toEqual([{ id: 'legacy' }])
    // 测试宿主显式修复其私有夹具，存储自身不得删除或猜测迁移旧数据
    inspecting.exec('ALTER TABLE threads RENAME TO retained_threads')
  }
  finally {
    inspecting.close()
  }
  const opened = await SqliteStore.create(options)

  try {
    expect(await opened.threads.listAll()).toEqual([])
    const retained = new DatabaseSync(filename)

    try {
      expect(retained.prepare('SELECT id FROM retained_threads').all()).toEqual([{ id: 'legacy' }])
    }
    finally {
      retained.close()
    }
  }
  finally {
    await opened.close()
  }
})

test('transaction connection setup failures close both clients and allow a clean retry', async () => {
  const context = await createStoreContext()
  const options = { ...context.options, dataDir: path.join(context.root, 'failed-setup-db') }
  const originalExec = DatabaseSync.prototype.exec
  const failure = new Error('transaction connection setup failed')
  const closing = vi.spyOn(DatabaseSync.prototype, 'close')
  const executing = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL')
      throw failure
    return originalExec.call(this, sql)
  })

  try {
    await expect(SqliteStore.create(options)).rejects.toBe(failure)
    expect(closing).toHaveBeenCalledTimes(2)
  }
  finally {
    executing.mockRestore()
    closing.mockRestore()
  }
  const retried = await SqliteStore.create(options)

  try {
    expect(await retried.threads.upsert({ id: 'thread_retry', dir: '.', agentId: 'code' })).toBeDefined()
  }
  finally {
    await retried.close()
  }
})

test('repeated transactions share one file owner and explicitly release every connection', async () => {
  const context = await createStoreContext()
  const { store, options, root } = context
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => SqliteStore.create(options)))

  expect(concurrent.every(candidate => candidate === store)).toBe(true)
  for (let cycle = 0; cycle < 10; cycle++) {
    const current = await SqliteStore.create(options)

    context.store = current

    try {
      for (let index = 0; index < 25; index++) {
        await current.transaction(async (tx) => {
          await tx.threads.upsert({ id: `thread_${cycle}_${index}`, dir: '.', agentId: 'code' })
          await Promise.resolve()
          await tx.threads.upsert({ id: `thread_${cycle}_${index}`, pinned: true })
        })
      }
      expect(await current.threads.listAll()).toHaveLength((cycle + 1) * 25)
    }
    finally {
      await current.close()
    }
  }
  // Windows 下连接未释放会导致删除失败，不能忽略 EBUSY
  await rm(path.join(root, 'db'), { recursive: true })
})

/** -------------------- 内部函数 -------------------- */
/**
 * 在测试私有目录创建文件存储并严格释放连接
 */
async function createStoreContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-sqlite-lifecycle-'))
  const options = {
    dataDir: path.join(root, 'db'),
    blobStore: LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') }),
  }
  const store = await SqliteStore.create(options)
  const context = { store, options, root }

  onTestFinished(async () => {
    await context.store.close()
    await rm(root, { recursive: true, force: true })
  })
  return context
}
