import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { writeThreadSnapshot } from '@elmino/thread'
import { onTestFinished } from 'vitest'

/** -------------------- 核心函数 -------------------- */
/**
 * 为每项能力测试创建独立 SQLite 与 BlobStore，关闭后只清理本次创建的临时目录
 */
export async function createThreadStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-thread-'))
  const blobStore = LocalBlobStore.create({
    rootDir: path.join(root, 'blobs'),
    files: {
      exists: async (file) => {
        try {
          await access(file)
          return true
        }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return false
          throw error
        }
      },
      readBytes: file => readFile(file),
      writeBytes: async (file, content) => {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
        return {}
      },
    },
  })
  const store = await SqliteStore.create({ dataDir: path.join(root, 'db'), blobStore })

  onTestFinished(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const threadId = createId('thread')
  const turnId = createId('turn')
  const location = { workspaceId: 'workspace-test', workspaceKind: 'project' as const, workspaceRoot: root, dir: '.', cwd: root }

  await writeThreadSnapshot(store, { threadId, agentId: 'test-agent', location })
  await store.turns.create({
    id: turnId,
    threadId,
    modelConfig: { id: 'host-model' },
    subagentRole: { id: 'test-role', name: 'Test', description: '', icon: 'bot', instructions: 'Complete the task' },
    subagentRoles: [],
    agentSnapshot: { id: 'test-agent' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
    status: 'running',
  })

  return { store, threadId, turnId, location }
}
