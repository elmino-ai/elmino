import type { EnvVars } from '@elmino/sandbox'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { objectEntries } from '@elmino/shared'
import { resolvePathKey } from '../env/env'

/** 不经过 Shell 的环境命令执行选项 */
export interface EnvCommandOptions {
  /** 子进程工作目录 */
  cwd?: string
  /** 子进程使用的完整环境变量投影 */
  env: EnvVars
  /** 当前运行平台 */
  platform?: NodeJS.Platform
  /** 取消当前命令 */
  signal?: AbortSignal
  /** 注入宿主的子进程创建入口 */
  spawn?: typeof spawn
  /** 命令最长运行时间 */
  timeoutMs?: number
}

/** -------------------- 核心函数 -------------------- */
/**
 * 按环境变量中的 PATH 和 PATHEXT 查找真实可执行文件
 */
export async function findEnvExecutable(
  command: string,
  env: EnvVars,
  platform: NodeJS.Platform = process.platform,
) {
  for (const candidate of resolveExecutableCandidates(command, env, platform)) {
    if (await isExecutableFile(candidate, platform))
      return candidate
  }

  return undefined
}

/**
 * 同步按环境变量中的 PATH 和 PATHEXT 查找真实可执行文件
 */
export function findEnvExecutableSync(
  command: string,
  env: EnvVars,
  platform: NodeJS.Platform = process.platform,
) {
  return resolveExecutableCandidates(command, env, platform)
    .find(candidate => isExecutableFileSync(candidate, platform))
}

/**
 * 不经过 Shell 执行单个环境命令
 */
export function runEnvCommand(
  command: string,
  args: readonly string[],
  options: EnvCommandOptions,
) {
  const {
    cwd,
    env,
    platform = process.platform,
    signal,
    timeoutMs,
  } = options

  if (signal?.aborted)
    return Promise.reject(createAbortError())
  const detached = platform !== 'win32'

  return new Promise<{ stderr: string, stdout: string }>((resolve, reject) => {
    const child = (options.spawn ?? spawn)(command, [...args], {
      cwd,
      detached,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    let terminating = false
    let abort = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined

    /** 结束侦听并只结算一次命令 */
    const settle = (handler: () => void) => {
      if (settled)
        return

      settled = true
      if (timer)
        clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      handler()
    }

    /** 等待进程树收束后再报告终止 */
    const terminate = (cause: Error) => {
      if (settled || terminating)
        return

      terminating = true
      terminateProcessTree(child, platform, env, closed, options.spawn ?? spawn)
        .then(() => settle(() => reject(cause)))
        .catch((cleanupError: unknown) => {
          settle(() => reject(new AggregateError(
            [cause, cleanupError],
            `终止命令后未能完成进程清理：${command}`,
          )))
        })
    }

    /** 取消命令并回收它创建的子进程 */
    abort = () => terminate(createAbortError())

    /** 超时后按失败边界终止整棵进程树 */
    const timeout = () => terminate(new Error(`命令执行超时：${command}`))

    timer = timeoutMs === undefined ? undefined : setTimeout(timeout, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout += chunk)
    child.stderr.on('data', chunk => stderr += chunk)
    child.once('error', (cause) => {
      if (!terminating)
        settle(() => reject(cause))
    })
    child.once('close', (code) => {
      if (terminating)
        return

      settle(() => {
        if (code === 0) {
          resolve({ stderr, stdout })
          return
        }

        const details = stderr.trim() || stdout.trim()

        reject(new Error(
          details
            ? `${command} 执行失败：${details}`
            : `${command} 执行失败，退出码 ${code ?? 'unknown'}`,
        ))
      })
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted)
      abort()
  })
}

/** -------------------- 内部函数 -------------------- */
/**
 * 按平台规则生成可执行文件候选路径
 */
function resolveExecutableCandidates(
  command: string,
  env: EnvVars,
  platform: NodeJS.Platform,
) {
  const pathPlatform = platform === 'win32' ? path.win32 : path.posix

  if (pathPlatform.isAbsolute(command))
    return [command]

  const delimiter = platform === 'win32' ? ';' : ':'
  const pathValue = env[resolvePathKey(env, platform)] ?? ''
  const extensions = platform === 'win32'
    ? readPathExtensions(env)
    : ['']

  return pathValue.split(delimiter).filter(Boolean).flatMap(dir => (
    extensions.map(extension => (
      pathPlatform.join(
        dir,
        appendExtension(command, extension, pathPlatform),
      )
    ))
  ))
}

/**
 * 在 Windows 使用 taskkill，在 POSIX 使用独立进程组终止后代进程
 */
async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  env: EnvVars,
  closed: Promise<void>,
  spawnProcess: typeof spawn,
) {
  if (!child.pid)
    return

  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    }
    catch {
      child.kill('SIGTERM')
    }
    const exited = await waitForProcessClose(closed, 2_000)

    // 父进程先退出时，同组且忽略 SIGTERM 的后代仍需回收。
    try {
      process.kill(-child.pid, 'SIGKILL')
    }
    catch {
      if (!exited)
        child.kill('SIGKILL')
    }

    if (!exited && !await waitForProcessClose(closed, 2_000))
      throw new Error(`无法终止环境命令进程：${child.pid}`)
    return
  }

  const cleanupErrors: unknown[] = []

  try {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    let spawnError: Error | undefined
    const killerClosed = new Promise<void>((resolve) => {
      killer.once('error', (cause) => {
        spawnError = cause
      })
      killer.once('close', () => resolve())
    })

    if (!await waitForProcessClose(killerClosed, 2_000)) {
      cleanupErrors.push(new Error('终止助手超时，无法确认命令进程树已清理'))
      try {
        killer.kill()
      }
      catch (cause) {
        cleanupErrors.push(cause)
      }
      if (!await waitForProcessClose(killerClosed, 2_000))
        cleanupErrors.push(new Error('无法确认终止助手进程已关闭：taskkill.exe'))
    }
    else if (spawnError) {
      cleanupErrors.push(spawnError)
    }
    else if (killer.exitCode !== 0) {
      cleanupErrors.push(new Error(`终止助手执行失败，退出码 ${killer.exitCode ?? 'unknown'}`))
    }
  }
  catch (cause) {
    cleanupErrors.push(cause)
  }

  if (cleanupErrors.length > 0) {
    try {
      child.kill()
    }
    catch (cause) {
      cleanupErrors.push(cause)
    }
  }
  if (!await waitForProcessClose(closed, 2_000))
    cleanupErrors.push(new Error(`无法终止环境命令进程：${child.pid}`))
  if (cleanupErrors.length === 1)
    throw cleanupErrors[0]
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, '无法完成 Windows 命令进程树清理')
}

/**
 * 在有限时间内等待子进程 close 事件
 */
function waitForProcessClose(
  closed: Promise<void>,
  timeoutMs: number,
) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs, false)

    closed.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 创建统一的命令取消错误
 */
function createAbortError() {
  return new DOMException('命令已取消', 'AbortError')
}

/**
 * 读取 Windows 可执行文件扩展名
 */
function readPathExtensions(env: EnvVars) {
  const value = objectEntries(env).find(([name]) => name.toLowerCase() === 'pathext')?.[1]
    ?? '.COM;.EXE;.BAT;.CMD'

  return ['', ...value.split(';').filter(Boolean)]
}

/**
 * 仅在命令尚无扩展名时追加 PATHEXT 候选
 */
function appendExtension(
  command: string,
  extension: string,
  pathPlatform: typeof path.posix | typeof path.win32,
) {
  if (!extension || pathPlatform.extname(command))
    return command

  return `${command}${extension.toLowerCase()}`
}

/**
 * 验证候选路径确实是普通可执行文件
 */
async function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
) {
  try {
    const info = await stat(filePath)

    if (!info.isFile())
      return false

    await access(
      filePath,
      platform === 'win32' ? constants.F_OK : constants.X_OK,
    )
    return true
  }
  catch {
    return false
  }
}

/**
 * 同步验证候选路径确实是普通可执行文件
 */
function isExecutableFileSync(
  filePath: string,
  platform: NodeJS.Platform,
) {
  try {
    if (!statSync(filePath).isFile())
      return false

    accessSync(
      filePath,
      platform === 'win32' ? constants.F_OK : constants.X_OK,
    )
    return true
  }
  catch {
    return false
  }
}
