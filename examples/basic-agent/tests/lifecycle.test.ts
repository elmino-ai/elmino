import { execFile } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const exec = promisify(execFile)
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'))
const cli = fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url))

/** 每个命令都是新进程，运行事实不能通过内存中的 Engine 或 Store 共享 */
async function run(command: string, dataDir: string, ...args: string[]) {
  const { stdout } = await exec(process.execPath, [tsx, cli, command, '--data-dir', dataDir, ...args], {
    timeout: 30_000,
    env: {
      ...process.env,
      ELMINO_EXAMPLE_MODEL: undefined,
      ELMINO_EXAMPLE_API_KEY: undefined,
      ELMINO_EXAMPLE_BASE_URL: undefined,
    },
  })
  return JSON.parse(stdout)
}

test('新进程审批恢复同一 Turn，并从 SQLite 和 blob 重新读取产物', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-example-approval-'))
  const started = await run('start', dataDir)
  expect(started).toMatchObject({
    status: 'interrupted',
    file: null,
    artifact: null,
    pending: [{ name: 'write_note', args: { text: 'Hello from elmino' } }],
    steps: ['completed'],
  })
  const inspected = await run('inspect', dataDir)
  expect(inspected).toMatchObject({
    threadId: started.threadId,
    turnId: started.turnId,
    workspaceId: started.workspaceId,
    status: 'interrupted',
    file: null,
  })
  await expect(run('start', dataDir)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('该目录已有示例会话'),
  })
  await expect(run('resume', dataDir)).rejects.toMatchObject({ code: 1 })
  expect(await run('inspect', dataDir)).toEqual(inspected)

  const resumed = await run('resume', dataDir, '--approve')
  expect(resumed).toMatchObject({
    threadId: started.threadId,
    turnId: started.turnId,
    status: 'completed',
    pending: [],
    steps: ['completed', 'completed'],
    tools: [{ name: 'write_note', status: 'completed', decision: 'approve' }],
    file: 'Hello from elmino',
    artifact: { id: started.artifactId, storage: 'blob', content: 'Hello from elmino' },
  })
  const file = path.join(dataDir, 'workspace/result.txt')
  expect(await readFile(file, 'utf8')).toBe('Hello from elmino')
  const before = await stat(file)
  const completed = await run('inspect', dataDir)
  expect(completed).toMatchObject({ status: 'completed', file: resumed.file, artifact: resumed.artifact })
  await expect(run('resume', dataDir, '--approve')).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('不能重复恢复'),
  })
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
  expect(await run('inspect', dataDir)).toEqual(completed)
}, 90_000)

test('拒绝审批后不会写文件或产物，重新检查保留拒绝结果', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-example-reject-'))
  const started = await run('start', dataDir)
  const rejected = await run('resume', dataDir, '--reject')
  expect(rejected).toMatchObject({
    threadId: started.threadId,
    turnId: started.turnId,
    status: 'completed',
    file: null,
    artifact: null,
    pending: [],
    tools: [{ name: 'write_note', status: 'skipped', decision: 'reject' }],
  })
  expect(await run('inspect', dataDir)).toMatchObject({
    status: 'completed',
    file: null,
    artifact: null,
    tools: rejected.tools,
  })
}, 90_000)
