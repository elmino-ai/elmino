import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalSandboxShell } from '@elmino/sandbox-local'
import { expect, test } from 'vitest'
import { createTestSandbox as createSandboxWithEnv, TEST_ENV } from './support/sandbox'

/** -------------------- 常量 -------------------- */
/** 仅在 @lydell/node-pty 提供预构建包的平台运行 PTY 测试 */
const ptyTest = ['darwin', 'linux', 'win32'].includes(process.platform)
  && ['arm64', 'x64'].includes(process.arch)
  ? test
  : test.skip
/** 仅在 POSIX 主机验证进程组信号 */
const posixTest = process.platform === 'win32' ? test.skip : test
/** 仅在 POSIX PTY 预构建平台验证终端 Ctrl-C */
const posixPtyTest = process.platform !== 'win32'
  && ['darwin', 'linux'].includes(process.platform)
  && ['arm64', 'x64'].includes(process.arch)
  ? test
  : test.skip

/** -------------------- 辅助函数 -------------------- */
/**
 * 创建独立临时目录和对应本地 Sandbox
 */
async function createTestSandbox(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `elmino-shell-${name}-`))

  return {
    root,
    sandbox: createSandboxWithEnv(root),
  }
}

/** -------------------- 测试 -------------------- */
test('close waits for accepted session creation and terminates the owned process', async () => {
  const { root, sandbox } = await createTestSandbox('pending-close')

  try {
    const running = sandbox.shell.run('node -e "setInterval(() => {}, 1000)"', { yield: 0.25 })
    const closing = sandbox.shell.dispose()

    expect(sandbox.shell.dispose()).toBe(closing)
    await expect(sandbox.shell.run('node -e "process.exit(0)"')).rejects.toThrow('Shell 执行环境已经关闭')
    await closing
    const result = await running

    expect(result.status).not.toBe('running')
    expect(result.sessionId).toBeUndefined()
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

posixTest('pipe 子进程使用 Runtime 冻结的环境快照', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-shell-env-'))
  const env = Object.freeze({
    ...TEST_ENV,
    ELMINO_PIPE_ENV: 'snapshot',
  })
  const sandbox = createSandboxWithEnv({ cwd: root, env })

  try {
    const result = await sandbox.shell.run(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.ELMINO_PIPE_ENV)"`,
    )

    expect(result.output).toBe('snapshot')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('local shell returns and streams completed output intact', async () => {
  const { root, sandbox } = await createTestSandbox('output')
  const deltas: string[] = []

  try {
    const result = await sandbox.shell.run(
      `node -e "process.stdout.write('x'.repeat(120000) + '-完整结尾')"`,
      {
        onOutput: (delta) => {
          deltas.push(delta)
        },
      },
    )

    expect(result).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(result.output).toBe(`${'x'.repeat(120_000)}-完整结尾`)
    expect(deltas.join('')).toBe(result.output)
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('pipe session yields and later polls only new output', async () => {
  const { root, sandbox } = await createTestSandbox('poll')

  try {
    const first = await sandbox.shell.run(
      'node -e "process.stdout.write(\'first\'); setTimeout(() => { process.stdout.write(\'second\') }, 400)"',
      { yield: 0.25 },
    )

    expect(first.status).toBe('running')
    expect(first.output).toBe('first')

    const second = await sandbox.shell.write(first.sessionId!, { yield: 2 })

    expect(second).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(second.output).toBe('second')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('pipe rejects ordinary stdin and remains explicitly terminable', async () => {
  const { root, sandbox } = await createTestSandbox('stdin')

  try {
    const running = await sandbox.shell.run(
      'node -e "setInterval(() => {}, 1000)"',
      { yield: 0.25 },
    )

    await expect(sandbox.shell.write(running.sessionId!, { input: 'hello\n' }))
      .rejects
      .toThrow('tty: true')
    await expect(sandbox.shell.terminate(running.sessionId!))
      .resolves
      .toMatchObject({ status: 'terminated' })
    await expect(sandbox.shell.write(running.sessionId!))
      .rejects
      .toThrow('不存在或已结束')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('pipe surfaces command startup failures without leaking a session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-shell-startup-'))
  const shell = LocalSandboxShell.create(root, {
    kind: 'sh',
    path: path.join(root, 'missing-shell'),
  }, TEST_ENV)

  try {
    await expect(shell.run('echo unavailable'))
      .rejects
      .toThrow()
  }
  finally {
    await shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

posixTest('pipe converts Ctrl-C input into a process-group interrupt', async () => {
  const { root, sandbox } = await createTestSandbox('interrupt')

  try {
    const running = await sandbox.shell.run(
      'node -e "process.on(\'SIGINT\', () => { console.log(\'interrupted\'); process.exit(0) }); setInterval(() => {}, 1000)"',
      { yield: 0.25 },
    )
    const result = await sandbox.shell.write(running.sessionId!, {
      input: '\u0003',
      yield: 2,
    })

    expect(result.status).toBe('exited')
    expect(result.output).toContain('interrupted')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('session timeout returns a terminal status instead of throwing', async () => {
  const { root, sandbox } = await createTestSandbox('timeout')

  try {
    await expect(sandbox.shell.run(
      'node -e "setInterval(() => {}, 1000)"',
      { timeout: 0.05, yield: 1 },
    )).resolves.toMatchObject({ status: 'timedOut' })
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('authorized Sandbox clones share the same shell sessions', async () => {
  const { root, sandbox } = await createTestSandbox('grants')

  try {
    const running = await sandbox.shell.run(
      'node -e "setTimeout(() => console.log(\'done\'), 400)"',
      { yield: 0.25 },
    )
    const granted = sandbox.withGrants([path.join(root, 'outside')])
    const result = await granted.shell.write(running.sessionId!, { yield: 2 })

    expect(result.status).toBe('exited')
    expect(result.output).toContain('done')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('unconsumed session output is capped with an omission marker', async () => {
  const { root, sandbox } = await createTestSandbox('limit')

  try {
    const result = await sandbox.shell.run(
      'node -e "process.stdout.write(\'x\'.repeat(1200000)); setTimeout(() => {}, 1000)"',
      { yield: 0.25 },
    )

    expect(result.status).toBe('running')
    expect(result.output).toContain('已省略')
    expect(Buffer.byteLength(result.output)).toBeLessThan(1024 * 1024 + 100)
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

ptyTest('PTY session accepts stdin and returns interactive output', async () => {
  const { root, sandbox } = await createTestSandbox('pty')

  try {
    const running = await sandbox.shell.run(
      'node -e "process.stdin.setEncoding(\'utf8\'); process.stdin.once(\'data\', input => { console.log(\'input:\' + input.trim()); process.exit(0) })"',
      { tty: true, yield: 0.25 },
    )
    const result = await sandbox.shell.write(running.sessionId!, {
      input: 'hello\n',
      yield: 2,
    })

    expect(result.status).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeUndefined()
    expect(result.output).toContain('input:hello')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

posixPtyTest('PTY session forwards Ctrl-C to the foreground process', async () => {
  const { root, sandbox } = await createTestSandbox('pty-interrupt')

  try {
    const running = await sandbox.shell.run(
      'node -e "process.on(\'SIGINT\', () => { console.log(\'pty-interrupted\'); process.exit(0) }); setInterval(() => {}, 1000)"',
      { tty: true, yield: 0.25 },
    )
    const result = await sandbox.shell.write(running.sessionId!, {
      input: '\u0003',
      yield: 2,
    })

    expect(result.status).toBe('exited')
    expect(result.output).toContain('pty-interrupted')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})

test('disposing Shell terminates all running sessions', async () => {
  const { root, sandbox } = await createTestSandbox('dispose')

  try {
    const running = await sandbox.shell.run(
      'node -e "setInterval(() => {}, 1000)"',
      { yield: 0.25 },
    )

    await sandbox.shell.dispose()
    await expect(sandbox.shell.write(running.sessionId!))
      .rejects
      .toThrow('已经关闭')
  }
  finally {
    await sandbox.shell.dispose()
    await rm(root, { force: true, recursive: true })
  }
})
