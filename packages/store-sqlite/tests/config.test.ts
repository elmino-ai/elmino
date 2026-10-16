import type { RuntimeStoreLease, RuntimeStoreProvider } from '@elmino/store'
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { sqliteStore, SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore, sha256 } from '@elmino/store/local'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('省略目录时按定义瞬间的 ELMINO_DATA_DIR 固定各配置，不提前打开数据库', async () => {
  const context = await createContext()
  const firstDir = path.join(context.root, 'first')
  const secondDir = path.join(context.root, 'second')
  vi.stubEnv('ELMINO_DATA_DIR', `  ${firstDir}  `)
  const first = sqliteStore()
  vi.stubEnv('ELMINO_DATA_DIR', secondDir)
  const second = sqliteStore()
  await expect(access(firstDir)).rejects.toMatchObject({ code: 'ENOENT' })
  await Promise.all([context.borrow(first), context.borrow(second)])
  await Promise.all([firstDir, secondDir].map(dir => access(path.join(dir, 'database', 'store.db'))))
})

test('显式目录优先于环境目录，两者均不影响进程原始变量', async () => {
  const context = await createContext()
  const dataDir = path.join(context.root, 'explicit')
  const ignored = path.join(context.root, 'ignored')
  vi.stubEnv('ELMINO_DATA_DIR', ignored)
  const provider = sqliteStore({ dataDir })
  await context.borrow(provider)
  await access(path.join(dataDir, 'database', 'store.db'))
  await expect(access(ignored)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(process.env.ELMINO_DATA_DIR).toBe(ignored)
})

test.each([undefined, '', '  '])('ELMINO_DATA_DIR 为 %j 时默认使用定义时 cwd 下的 .elmino，不改写环境', async (value) => {
  const context = await createContext()
  vi.stubEnv('ELMINO_DATA_DIR', value)
  const unrelated = path.join(context.root, 'another-application')
  vi.stubEnv('DATA_DIR', unrelated)
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(context.root)
  let provider: RuntimeStoreProvider
  try {
    provider = sqliteStore()
  }
  finally {
    cwd.mockRestore()
  }
  await context.borrow(provider)
  await access(path.join(context.root, '.elmino', 'database', 'store.db'))
  await expect(access(unrelated)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(process.env.ELMINO_DATA_DIR).toBe(value)
})

test('配置不创建目录，首次借用后持久化线程和大产物，释放后可重开复用', async () => {
  const context = await createContext()
  const dataDir = path.join(context.root, 'data')
  const provider = sqliteStore({ dataDir })
  await expect(access(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
  const first = await context.borrow(provider)
  const thread = await first.store.threads.upsert({ id: 'thread_persistent', dir: '.', agentId: 'test' })
  const content = 'persistent artifact line\n'.repeat(30_000)
  const artifact = await first.store.artifacts.write({
    threadId: thread.id,
    contentKind: 'text',
    contentText: content,
  })

  expect(artifact).toMatchObject({ storage: 'blob', state: 'available', sha256: sha256(content) })
  expect(artifact.blobKey).toBeTruthy()
  await access(path.join(dataDir, 'database', 'store.db'))
  expect(await readFile(path.join(dataDir, 'blobs', artifact.blobKey!), 'utf8')).toBe(content)
  await first.release()
  await expect(first.store.threads.listAll()).rejects.toThrow('已经关闭')
  const reopened = await context.borrow(provider)

  expect(reopened.store).not.toBe(first.store)
  expect(await reopened.store.threads.read(thread.id)).toEqual(thread)
  expect(await reopened.store.artifacts.read(artifact.id)).toEqual(artifact)
  expect(await readFile(path.join(dataDir, 'blobs', artifact.blobKey!), 'utf8')).toBe(content)
})

test('同一配置并发借用共享实例，每个持有者只释放一次，最后释放才关闭', async () => {
  const context = await createContext()
  const provider = sqliteStore({ dataDir: path.join(context.root, 'data') })
  const leases = await Promise.all(Array.from({ length: 8 }, () => context.borrow(provider)))
  const first = leases[0]!
  expect(leases.every(lease => lease.store === first.store)).toBe(true)
  await first.store.threads.upsert({ id: 'thread_shared', dir: '.', agentId: 'test' })
  const releasing = first.release()
  expect(first.release()).toBe(releasing)
  await releasing
  await Promise.all(leases.slice(1, -1).map(lease => lease.release()))
  expect(await first.store.threads.read('thread_shared')).toBeDefined()
  const last = leases.at(-1)!
  const closing = last.release()
  expect(last.release()).toBe(closing)
  await closing
  await expect(first.store.threads.listAll()).rejects.toThrow('已经关闭')
})

test('最后释放等待已接纳事务，释放过程中再借用等待关闭并打开新实例', async () => {
  const context = await createContext()
  const provider = sqliteStore({ dataDir: path.join(context.root, 'data') })
  const first = await context.borrow(provider)
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const writing = first.store.transaction(async (tx) => {
    entered.resolve()
    await proceed.promise
    await tx.threads.upsert({ id: 'thread_before_release', dir: '.', agentId: 'test' })
  })
  await entered.promise
  const releasing = first.release()
  let borrowed = false
  const borrowing = context.borrow(provider).then((lease) => {
    borrowed = true
    return lease
  })
  try {
    await setImmediate()
    expect(borrowed).toBe(false)
    proceed.resolve()
    await Promise.all([writing, releasing])
    const next = await borrowing
    expect(next.store).not.toBe(first.store)
    expect(await next.store.threads.read('thread_before_release')).toBeDefined()
  }
  finally {
    proceed.resolve()
    await Promise.all([writing, releasing, borrowing])
  }
})

test('并发打开失败不留下持有者，修复私有目录后同一配置可重试', async () => {
  const context = await createContext()
  const dataDir = path.join(context.root, 'blocked')
  await writeFile(dataDir, '保留宿主文件')
  const provider = sqliteStore({ dataDir })
  const attempts = await Promise.allSettled([provider(), provider()])
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled')
      context.cleanup.push(attempt.value.release)
  }
  expect(attempts.every(result => result.status === 'rejected')).toBe(true)
  expect(await readFile(dataDir, 'utf8')).toBe('保留宿主文件')
  await unlink(dataDir)
  const recovered = await context.borrow(provider)
  expect(await recovered.store.threads.listAll()).toEqual([])
  await recovered.release()
  await expect(recovered.store.threads.listAll()).rejects.toThrow('已经关闭')
})

test('不同配置不能接管同目录，失败借用不关闭原配置的存储', async () => {
  const context = await createContext()
  const dataDir = path.join(context.root, 'data')
  const firstProvider = sqliteStore({ dataDir })
  const secondProvider = sqliteStore({ dataDir })
  const first = await context.borrow(firstProvider)
  await expect(secondProvider()).rejects.toThrow('已经绑定其他 BlobStore')
  await first.store.threads.upsert({ id: 'thread_first_owner', dir: '.', agentId: 'test' })
  const shared = await context.borrow(firstProvider)
  expect(shared.store).toBe(first.store)
  await Promise.all([first.release(), shared.release()])
  const second = await context.borrow(secondProvider)
  expect(second.store).not.toBe(first.store)
  expect(await second.store.threads.read('thread_first_owner')).toBeDefined()
})

test('手动实例持有同目录时，简写配置失败不关闭它，显式释放后才能借用', async () => {
  const context = await createContext()
  const dataDir = path.join(context.root, 'data')
  const manual = await SqliteStore.create({
    dataDir: path.join(dataDir, 'database'),
    blobStore: LocalBlobStore.create({ rootDir: path.join(dataDir, 'blobs') }),
  })
  context.cleanup.push(() => manual.close())
  const provider = sqliteStore({ dataDir })
  await expect(provider()).rejects.toThrow('已经绑定其他 BlobStore')
  await manual.threads.upsert({ id: 'thread_manual_owner', dir: '.', agentId: 'test' })
  expect(await manual.threads.read('thread_manual_owner')).toBeDefined()
  await manual.close()
  const lease = await context.borrow(provider)
  expect(lease.store).not.toBe(manual)
  expect(await lease.store.threads.read('thread_manual_owner')).toBeDefined()
})

/** 测试拥有自己的临时根目录与借用凭据，清理不触及用户数据 */
async function createContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-sqlite-config-'))
  const cleanup: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    try {
      await Promise.all(cleanup.map(release => release()))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  return {
    root,
    cleanup,
    async borrow(provider: RuntimeStoreProvider): Promise<RuntimeStoreLease> {
      const lease = await provider()
      cleanup.push(lease.release)
      return lease
    },
  }
}
