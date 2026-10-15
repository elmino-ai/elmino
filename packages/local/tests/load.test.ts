import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { loadUserEnv } from '@elmino/local'
import { expect, test, vi } from 'vitest'

/** -------------------- 常量 -------------------- */
/** 登录 Shell 环境输出标记 */
const MARKER = '\0__ELMINO_USER_ENV__\0'
/** 打包桌面端启动时的受限环境 */
const GUI_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/** -------------------- 测试辅助 -------------------- */
/**
 * 创建带 stdout 流和 kill mock 的假子进程
 */
function createFakeChild() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  })

  return child
}

/** -------------------- 测试 -------------------- */
test.each(['/bin/zsh', '/bin/bash'])('通过 %s 加载完整用户环境', async (shellPath) => {
  const child = createFakeChild()
  const spawn = vi.fn().mockReturnValue(child)
  const promise = loadUserEnv({
    env: GUI_ENV,
    platform: 'darwin',
    shellPath,
    spawn: spawn as never,
  })

  child.stdout.write([
    'profile output',
    MARKER,
    'PATH=/opt/conda/bin:/usr/bin:/bin',
    'CONDA_DEFAULT_ENV=base',
    'CONDA_PREFIX=/opt/conda',
    MARKER,
  ].join('\0'))
  child.emit('close', 0)
  const env = await promise

  expect(spawn).toHaveBeenCalledWith(
    shellPath,
    ['-lic', expect.stringContaining('__ELMINO_USER_ENV__')],
    expect.objectContaining({
      env: expect.objectContaining({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }),
      detached: true,
      shell: false,
    }),
  )
  expect(env).toMatchObject({
    CONDA_DEFAULT_ENV: 'base',
    CONDA_PREFIX: '/opt/conda',
    PATH: '/opt/conda/bin:/usr/bin:/bin',
  })
  expect(GUI_ENV.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
})

test('启动登录 Shell 前清除继承来的半激活 Conda 状态', async () => {
  const child = createFakeChild()
  const spawn = vi.fn().mockReturnValue(child)
  const promise = loadUserEnv({
    env: {
      CONDA_DEFAULT_ENV: 'base',
      CONDA_PREFIX: '/stale/conda',
      PATH: '/stale/conda/bin:/usr/bin',
    },
    platform: 'darwin',
    shellPath: '/bin/zsh',
    spawn: spawn as never,
  })

  child.stdout.write(`${MARKER}PATH=/fresh/conda/bin:/usr/bin\0CONDA_PREFIX=/fresh/conda\0${MARKER}`)
  child.emit('close', 0)
  const env = await promise
  const spawnEnv = spawn.mock.calls[0]?.[2]?.env

  expect(spawnEnv).not.toHaveProperty('CONDA_DEFAULT_ENV')
  expect(spawnEnv).not.toHaveProperty('CONDA_PREFIX')
  expect(env.PATH).toBe('/fresh/conda/bin:/usr/bin')
})

test('Windows 直接返回系统环境且不启动 Shell', async () => {
  const spawn = vi.fn() as never
  const env = await loadUserEnv({
    env: { Path: 'C:\\Windows\\System32', USERNAME: 'green' },
    platform: 'win32',
    spawn,
  })

  expect(spawn).not.toHaveBeenCalled()
  expect(env).toEqual({ Path: 'C:\\Windows\\System32', USERNAME: 'green' })
})

test('Shell 失败时返回干净启动环境且不修改传入对象', async () => {
  const child = createFakeChild()
  const spawn = vi.fn().mockReturnValue(child) as never
  const inherited = { CONDA_PREFIX: '/stale/conda', PATH: '/stale/conda/bin' }
  const promise = loadUserEnv({
    env: inherited,
    platform: 'darwin',
    shellPath: '/bin/zsh',
    spawn,
  })

  child.emit('error', new Error('ENOENT'))
  const env = await promise

  expect(env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  expect(inherited).toEqual({ CONDA_PREFIX: '/stale/conda', PATH: '/stale/conda/bin' })
})

test('环境值保留换行、等号、尾部空格和同名标记文本', async () => {
  const child = createFakeChild()
  const promise = loadUserEnv({
    env: GUI_ENV,
    shellPath: '/test/shell',
    platform: 'linux',
    spawn: vi.fn().mockReturnValue(child) as never,
  })

  child.stdout.write(`${MARKER}PATH=/bin\0VALUE=first\nsecond=part  \0TEXT=__ELMINO_USER_ENV__\0${MARKER}`)
  child.emit('close', 0)
  await expect(promise).resolves.toEqual({
    PATH: '/bin',
    VALUE: 'first\nsecond=part  ',
    TEXT: '__ELMINO_USER_ENV__',
  })
})

test.each(['缺少标记', `${MARKER}NO_PATH=value\0${MARKER}`])('不完整输出使用回退环境', async (output) => {
  const child = createFakeChild()
  const promise = loadUserEnv({
    env: { ...GUI_ENV, VIRTUAL_ENV: '/stale', VALUE: 'inherited' },
    shellPath: '/test/shell',
    platform: 'linux',
    spawn: vi.fn().mockReturnValue(child) as never,
  })

  child.stdout.write(output)
  child.emit('close', 0)
  await expect(promise).resolves.toEqual({ ...GUI_ENV, VALUE: 'inherited' })
})

test('进程创建同步失败与异步启动错误采用相同回退', async () => {
  const env = await loadUserEnv({
    env: GUI_ENV,
    shellPath: '/test/missing',
    platform: 'linux',
    spawn: vi.fn(() => { throw new Error('创建失败') }) as never,
  })

  expect(env).toEqual(GUI_ENV)
})

test('非零退出即便有输出也使用回退环境', async () => {
  const child = createFakeChild()
  const promise = loadUserEnv({
    env: GUI_ENV,
    shellPath: '/test/shell',
    platform: 'linux',
    spawn: vi.fn().mockReturnValue(child) as never,
  })

  child.stdout.write(`${MARKER}PATH=/partial\0${MARKER}`)
  child.emit('close', 1)
  await expect(promise).resolves.toEqual(GUI_ENV)
})

test.skipIf(process.platform === 'win32')('超时回退前等待实际子进程关闭', async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  let closed = false
  const spawn = vi.fn((_: string, _args: string[], options: SpawnOptions) => {
    child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, stdio: 'pipe' })
    child.once('close', () => closed = true)
    return child
  })
  const result = await loadUserEnv({
    env: GUI_ENV,
    shellPath: '/test/controlled',
    platform: 'linux',
    spawn: spawn as never,
    timeoutMs: 50,
  })

  expect(result).toEqual(GUI_ENV)
  expect(closed).toBe(true)
  expect(child?.pid).toBeTypeOf('number')
})

test('清理失败保留失败原因，不当作已完成的环境回退', async () => {
  const failure = new AggregateError([new Error('超时'), new Error('清理失败')], '进程尚未关闭')

  await expect(loadUserEnv({
    env: GUI_ENV,
    shellPath: '/test/shell',
    platform: 'linux',
    spawn: vi.fn(() => { throw failure }) as never,
  })).rejects.toBe(failure)
})

test.skipIf(process.platform === 'win32')('真实受控 Shell 保留完整环境记录且不读取用户 profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elmino-login-env-'))
  const wrapper = path.join(root, 'shell')

  try {
    await writeFile(wrapper, '#!/bin/sh\nexec /bin/sh -c "$2"\n', 'utf8')
    await chmod(wrapper, 0o755)
    const env = await loadUserEnv({
      env: { PATH: '/inherited', VALUE: 'first\nsecond=last  ', CONDA_PREFIX: '/stale' },
      shellPath: wrapper,
      platform: 'linux',
    })

    expect(env.VALUE).toBe('first\nsecond=last  ')
    expect(env.PATH).toBe(GUI_ENV.PATH)
    expect(env).not.toHaveProperty('CONDA_PREFIX')
    expect(Object.isFrozen(env)).toBe(true)
  }
  finally {
    await unlink(wrapper)
    await rmdir(root)
  }
})
