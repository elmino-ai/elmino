import type { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { findEnvExecutable, findEnvExecutableSync, runEnvCommand } from '@elmino/local'
import { afterEach, expect, test, vi } from 'vitest'

/** 测试拥有的临时目录 */
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

/** 为单个测试建立隔离目录 */
async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-process-'))
  roots.push(root)
  return root
}

test('同步和异步探测按 PATH 顺序返回普通可执行文件并支持绝对路径', async () => {
  const root = await createRoot()
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  const executable = path.join(second, 'command')
  await writeFile(executable, 'executable')
  await chmod(executable, 0o755)
  await mkdir(path.join(first, 'command'))
  const env = { PATH: [first, second].join(path.delimiter) }

  expect(await findEnvExecutable('command', env)).toBe(executable)
  expect(findEnvExecutableSync('command', env)).toBe(executable)
  expect(await findEnvExecutable(executable, {})).toBe(executable)
  expect(findEnvExecutableSync(executable, {})).toBe(executable)
  expect(await findEnvExecutable('missing', env)).toBeUndefined()
  expect(findEnvExecutableSync('missing', env)).toBeUndefined()
})

test.skipIf(process.platform === 'win32')('POSIX 探测跳过没有执行权限的普通文件', async () => {
  const root = await createRoot()
  const file = path.join(root, 'command')
  await writeFile(file, 'not executable')
  await chmod(file, 0o644)

  expect(await findEnvExecutable('command', { PATH: root })).toBeUndefined()
  expect(findEnvExecutableSync('command', { PATH: root })).toBeUndefined()
})

test('命令使用注入的环境和工作目录，参数保持原样且不经过 Shell', async () => {
  const cwd = await createRoot()
  const argument = 'literal; $(echo unwanted) with spaces'
  const result = await runEnvCommand(process.execPath, [
    '-e',
    'console.log(JSON.stringify({cwd:process.cwd(),value:process.env.VALUE,arg:process.argv[1]}));console.error("diagnostic")',
    argument,
  ], { cwd, env: { VALUE: 'injected' } })

  expect(JSON.parse(result.stdout)).toEqual({ cwd: await realpath(cwd), value: 'injected', arg: argument })
  expect(result.stderr.trim()).toBe('diagnostic')
})

test('无输入命令收到 EOF，读取标准输入能够返回空字符串并正常退出', async () => {
  const result = await runEnvCommand(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(require("node:fs").readFileSync(0,"utf8")))',
  ], { env: {}, timeoutMs: 1_000 })

  expect(result).toEqual({ stdout: '""', stderr: '' })
})

test('命令失败优先保留标准错误，没有输出时提供退出码', async () => {
  await expect(runEnvCommand(process.execPath, ['-e', 'console.log("out");console.error("cause");process.exit(7)'], { env: {} }))
    .rejects
    .toThrow('执行失败：cause')
  await expect(runEnvCommand(process.execPath, ['-e', 'process.exit(7)'], { env: {} }))
    .rejects
    .toThrow('退出码 7')
  await expect(runEnvCommand(process.execPath, ['-e', 'console.log("fallback");process.exit(1)'], { env: {} }))
    .rejects
    .toThrow('执行失败：fallback')
})

test('不存在的程序保留 spawn 错误', async () => {
  const root = await createRoot()
  await expect(runEnvCommand(path.join(root, 'missing'), [], { env: {} }))
    .rejects
    .toMatchObject({ code: 'ENOENT' })
})

test('已取消的命令不会开始执行', async () => {
  const signal = AbortSignal.abort('cancelled')
  await expect(runEnvCommand(process.execPath, ['-e', 'process.exit(42)'], { env: {}, signal }))
    .rejects
    .toMatchObject({ name: 'AbortError' })
})

test('运行中的命令取消后回收进程再报告 AbortError', async () => {
  const controller = new AbortController()
  const command = runEnvCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {},
    signal: controller.signal,
  })
  controller.abort()
  await expect(command).rejects.toMatchObject({ name: 'AbortError' })
})

test('命令超时后退出，不挂起调用方', async () => {
  await expect(runEnvCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {},
    timeoutMs: 50,
  })).rejects.toThrow('命令执行超时')
})

test.skipIf(process.platform === 'win32')('父进程先退出时仍回收忽略 SIGTERM 且不继承输出的孙进程', async () => {
  const root = await createRoot()
  const pidFile = path.join(root, 'descendant.pid')
  const childScript = [
    'process.on("SIGTERM",()=>{});',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
    'setInterval(()=>{},1000)',
  ].join('')
  const parentScript = [
    `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});`,
    'setInterval(()=>{},1000)',
  ].join('')
  const controller = new AbortController()
  let pid: number | undefined
  const command = runEnvCommand(process.execPath, ['-e', parentScript], { env: {}, signal: controller.signal })
  const cancelled = expect(command).rejects.toMatchObject({ name: 'AbortError' })

  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidFile, 'utf8'))
      expect(pid).toBeGreaterThan(0)
    })
    controller.abort()
    await cancelled
    await vi.waitFor(() => {
      let state = ''
      try {
        state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      }
      catch {
        // ps 在进程已经消失时返回非零退出码。
      }
      expect(state === '' || state.startsWith('Z')).toBe(true)
    })
  }
  finally {
    controller.abort()
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {
        // 测试只回收自己创建且可能已结束的后代。
      }
    }
    await command.catch(() => undefined)
  }
})

test('Windows 终止助手成功且主进程与助手都关闭后才报告取消', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  const killer = Object.assign(new EventEmitter(), { exitCode: 0, kill: vi.fn(() => true) })
  const spawnProcess = vi.fn((command: string) => command === 'taskkill.exe' ? killer : child)
  const controller = new AbortController()
  let settled = false

  try {
    const command = runEnvCommand('command.exe', [], {
      env: {},
      platform: 'win32',
      signal: controller.signal,
      spawn: spawnProcess as unknown as typeof spawn,
    })
    const cancelled = expect(command).rejects.toMatchObject({ name: 'AbortError' })
    command.then(() => settled = true, () => settled = true)
    controller.abort()
    child.emit('close', null)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    killer.emit('close', 0)
    await cancelled
    expect(killer.kill).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenNthCalledWith(2, 'taskkill.exe', ['/pid', '123', '/t', '/f'], expect.objectContaining({ shell: false }))
  }
  finally {
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})

test.each([true, false])('Windows 终止助手挂起后关闭状态为 %s 时均保留进程树清理失败', async (helperCloses) => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  const killer = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn(() => true) })
  const spawnProcess = vi.fn((command: string) => command === 'taskkill.exe' ? killer : child)
  const controller = new AbortController()
  let settled = false

  try {
    const command = runEnvCommand('command.exe', [], {
      env: {},
      platform: 'win32',
      signal: controller.signal,
      spawn: spawnProcess as unknown as typeof spawn,
    })
    const rejected = expect(command).rejects.toBeInstanceOf(AggregateError)
    command.then(() => settled = true, () => settled = true)
    controller.abort()
    child.emit('close', null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(killer.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    if (helperCloses)
      killer.emit('close', null)
    else
      await vi.advanceTimersByTimeAsync(2_000)
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    const failure = await command.catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ errors: [{ name: 'AbortError' }, expect.any(Error)] })
    expect((failure as AggregateError).errors[1]).toMatchObject({
      message: helperCloses ? '终止助手超时，无法确认命令进程树已清理' : '无法完成 Windows 命令进程树清理',
    })
  }
  finally {
    killer.emit('close', null)
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})

test.each(['spawn', 'error', 'exit'] as const)('Windows 终止助手 %s 失败时等待主进程关闭并报告清理失败', async (mode) => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  const killer = Object.assign(new EventEmitter(), { exitCode: 1 })
  const spawnProcess = vi.fn((command: string) => {
    if (command !== 'taskkill.exe')
      return child
    if (mode === 'spawn')
      throw new Error('cannot spawn taskkill')
    queueMicrotask(() => {
      if (mode === 'error')
        killer.emit('error', new Error('taskkill error'))
      else
        killer.emit('close', 1)
    })
    return killer
  })
  const controller = new AbortController()
  let settled = false

  try {
    const command = runEnvCommand('command.exe', [], {
      env: {},
      platform: 'win32',
      signal: controller.signal,
      spawn: spawnProcess as unknown as typeof spawn,
    })
    const rejected = expect(command).rejects.toBeInstanceOf(AggregateError)
    command.then(() => settled = true, () => settled = true)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    if (mode === 'error') {
      expect(child.kill).not.toHaveBeenCalled()
      expect(settled).toBe(false)
      killer.emit('close', 1)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(child.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    child.emit('close', null)
    await rejected
    await expect(command).rejects.toMatchObject({ errors: [{ name: 'AbortError' }, expect.any(Error)] })
  }
  finally {
    child.emit('close', null)
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})

test('timeoutMs 为零时立即超时，不会禁用上限', async () => {
  await expect(runEnvCommand(process.execPath, ['-e', 'setTimeout(()=>{},200)'], {
    env: {},
    timeoutMs: 0,
  })).rejects.toThrow('命令执行超时')
})

test('注入的 spawn 同步触发取消时仍能终止新建命令', async () => {
  const controller = new AbortController()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const killer = Object.assign(new EventEmitter(), { exitCode: 0 })
  const spawnProcess = vi.fn((command: string) => {
    if (command === 'taskkill.exe') {
      queueMicrotask(() => {
        killer.emit('close', 0)
        child.emit('close', null)
      })
      return killer
    }
    controller.abort()
    return child
  })

  try {
    await expect(runEnvCommand('command.exe', [], {
      env: {},
      platform: 'win32',
      signal: controller.signal,
      spawn: spawnProcess as unknown as typeof spawn,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnProcess).toHaveBeenCalledTimes(2)
  }
  finally {
    child.stdout.destroy()
    child.stderr.destroy()
  }
})

test('终止后主进程仍不关闭时保留取消原因和清理错误', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const killer = Object.assign(new EventEmitter(), { exitCode: 0 })
  const spawnProcess = vi.fn((command: string) => {
    if (command !== 'taskkill.exe')
      return child
    queueMicrotask(() => killer.emit('close', 0))
    return killer
  })
  const controller = new AbortController()

  try {
    const command = runEnvCommand('command.exe', [], {
      env: {},
      platform: 'win32',
      signal: controller.signal,
      spawn: spawnProcess as unknown as typeof spawn,
    })
    const rejected = expect(command).rejects.toMatchObject({
      errors: [
        { name: 'AbortError' },
        { message: '无法终止环境命令进程：123' },
      ],
    })
    controller.abort()
    await vi.advanceTimersByTimeAsync(2_000)
    await rejected
    await expect(command).rejects.toBeInstanceOf(AggregateError)
  }
  finally {
    child.emit('close', null)
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})
