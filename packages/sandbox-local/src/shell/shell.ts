import type {
  EnvVars,
  LocalShell,
  LocalShellKind,
  LocalShellResolver,
  SandboxRunOptions,
  SandboxShell,
  SandboxShellOutputHandler,
  SandboxShellResult,
  SandboxShellStatus,
  SandboxShellWriteOptions,
} from '@elmino/sandbox'
import type { Promisable } from '@elmino/shared'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import {
  DEFAULT_SANDBOX_SHELL_YIELD_SECONDS,
  MAX_SANDBOX_SHELL_TIMEOUT_SECONDS,
  MAX_SANDBOX_SHELL_YIELD_SECONDS,
  MIN_SANDBOX_SHELL_YIELD_SECONDS,
} from '@elmino/sandbox'
import { createId, throwSettledErrors } from '@elmino/shared'
import crossSpawn from 'cross-spawn'
import { LocalPtyHost } from '../pty/host.js'

/** -------------------- 类型 -------------------- */
/** 子进程退出结果 */
interface LocalShellExit {
  /** 进程退出码 */
  code: number | null
  /** 进程退出信号 */
  signal: string | null
}

/** pipe 与 PTY 归一后的最小进程能力 */
interface LocalShellProcess {
  /** PTY 模式 */
  tty: boolean
  /** 进程和输出完成 */
  completion: Promise<LocalShellExit>
  /** PTY 写入 */
  write?: (input: string) => void
  /** 终止进程树 */
  kill: (signal: NodeJS.Signals) => Promisable<void>
}

/** 可继续操作的 Shell 会话 */
interface LocalShellSession {
  /** 稳定会话 ID */
  id: string
  /** 子进程 */
  process: LocalShellProcess
  /** 会话状态 */
  status: SandboxShellStatus
  /** 待返回输出 */
  output: string
  /** 已丢弃输出字节数 */
  omittedBytes: number
  /** 输出回调队列 */
  progress: Promise<void>
  /** 当前输出回调 */
  onOutput?: SandboxShellOutputHandler
  /** 退出码 */
  exitCode?: number | null
  /** 退出信号 */
  signal?: string
  /** 会话错误 */
  failure?: unknown
  /** 超时定时器 */
  timeout?: ReturnType<typeof setTimeout>
  /** 会话完成 */
  completion: Promise<void>
  /** 会话是否完成 */
  completed: boolean
  /** 是否被占用 */
  busy: boolean
}

/** -------------------- 常量 -------------------- */
/** 强制终止等待时间 */
const PROCESS_FORCE_KILL_TIMEOUT_MS = 3_000
/** 输出缓存上限 */
const MAX_SESSION_OUTPUT_BYTES = 1024 * 1024
/** 会话上限 */
const MAX_SHELL_SESSIONS = 64
/** pipe 中断输入 */
const INTERRUPT_INPUT = '\u0003'
/** PTY 默认终端尺寸 */
const PTY_SIZE = { cols: 80, rows: 24 }

/** -------------------- 核心类 -------------------- */
/**
 * 管理本地 Shell 会话
 */
export class LocalSandboxShell implements SandboxShell {
  /** Shell 缓存 */
  private readonly _shells = new Map<LocalShellKind, LocalShell>()

  /** PTY 会话底座 */
  private readonly _pty: LocalPtyHost

  /** 会话缓存 */
  private readonly _sessions = new Map<string, LocalShellSession>()

  /** 已接纳但尚未完成进程创建与登记的会话 */
  private readonly _opening = new Set<Promise<LocalShellSession>>()

  /** 拒绝新调用并等待全部资源释放的幂等关闭任务 */
  private _closing?: Promise<void>

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建本地 Shell 会话管理器
   */
  public static create(
    cwd: string,
    shell: LocalShell,
    env: EnvVars,
    resolveShell?: LocalShellResolver,
  ) {
    const pty = LocalPtyHost.create()

    return new LocalSandboxShell(cwd, shell, env, pty, resolveShell)
  }

  /**
   * 记录命令默认执行目录
   */
  private constructor(
    private readonly _cwd: string,
    private readonly _shell: LocalShell,
    private readonly _env: EnvVars,
    pty: LocalPtyHost,
    private readonly _resolveLocalShell?: LocalShellResolver,
  ) {
    this._pty = pty
    this._shells.set(this._shell.kind, this._shell)
  }

  /**
   * 启动命令并在退出或本次等待截止时返回
   */
  public async run(command: string, options: SandboxRunOptions = {}) {
    this._assertAvailable(options.signal)
    this._discardOldestCompletedSession()
    if (this._sessions.size + this._opening.size >= MAX_SHELL_SESSIONS) {
      throw new Error(
        `Shell 会话数已达上限（${MAX_SHELL_SESSIONS}），请先终止不再需要的会话`,
      )
    }

    const shell = options.shell
      ? this._resolveShell(options.shell)
      : this._shell
    const timeoutSeconds = this._resolveTimeout(options.timeout)
    const opening = this._openSession(
      shell,
      command,
      options.tty === true,
      timeoutSeconds,
    )

    this._opening.add(opening)
    const session = await opening.finally(() => this._opening.delete(opening))

    return this._wait(session, {
      signal: options.signal,
      yield: options.yield,
      onOutput: options.onOutput,
    }, DEFAULT_SANDBOX_SHELL_YIELD_SECONDS)
  }

  /**
   * 写入或轮询已有 Shell 会话
   */
  public async write(sessionId: string, options: SandboxShellWriteOptions = {}) {
    this._assertAvailable(options.signal)
    const session = this._session(sessionId)

    this._acquire(session)

    try {
      const input = options.input ?? ''

      if (session.status === 'running' && input) {
        if (!session.process.tty) {
          if (input !== INTERRUPT_INPUT) {
            throw new Error(
              '普通 pipe 会话不支持写入 stdin；请终止该会话并使用 tty: true 重新执行命令',
            )
          }

          await session.process.kill('SIGINT')
        }
        else {
          session.process.write?.(input)
        }
      }

      return await this._wait(
        session,
        options,
        input ? MIN_SANDBOX_SHELL_YIELD_SECONDS : DEFAULT_SANDBOX_SHELL_YIELD_SECONDS,
      )
    }
    finally {
      session.busy = false
    }
  }

  /**
   * 终止已有 Shell 会话并返回最终输出
   */
  public async terminate(sessionId: string) {
    this._assertAvailable()
    const session = this._session(sessionId)

    this._acquire(session)

    try {
      if (session.status === 'running')
        await this._stop(session, 'terminated')
      else
        await session.completion

      return this._takeResult(session)
    }
    finally {
      session.busy = false
    }
  }

  /**
   * 关闭全部会话
   */
  public dispose() {
    if (this._closing)
      return this._closing

    this._closing = (async () => {
      // 已接纳的创建必须先登记；关闭不能漏掉 mkdir 或 spawn 仍在等待的进程
      await Promise.allSettled(this._opening)
      const sessions = [...this._sessions.values()]
      const stopped = await Promise.allSettled(sessions.map(async (session) => {
        if (session.status === 'running')
          await this._stop(session, 'terminated')
        else
          await session.completion

        await session.progress
      }))
      this._sessions.clear()
      const pty = await Promise.allSettled([this._pty.dispose()])

      throwSettledErrors([...stopped, ...pty], '关闭 Shell 执行资源失败')
    })()

    return this._closing
  }

  /** -------------------- 会话方法 -------------------- */
  /**
   * 创建并登记一个 pipe 或 PTY 会话
   */
  private async _openSession(
    shell: LocalShell,
    command: string,
    tty: boolean,
    timeoutSeconds?: number,
  ) {
    await mkdir(this._cwd, { recursive: true })
    let session: LocalShellSession | undefined
    const pendingOutput: string[] = []
    /** 在会话登记前暂存极早到达的进程输出 */
    const onOutput = (output: string) => {
      if (session)
        this._appendOutput(session, output)
      else
        pendingOutput.push(output)
    }
    const process = await (tty
      ? this._spawnPty(shell, command, onOutput)
      : this._spawnPipe(shell, command, onOutput)
    )
    const id = createId('process')

    session = {
      id,
      process,
      status: 'running',
      output: '',
      omittedBytes: 0,
      progress: Promise.resolve(),
      completion: Promise.resolve(),
      completed: false,
      busy: false,
    }
    this._sessions.set(id, session)

    for (const output of pendingOutput)
      this._appendOutput(session, output)

    session.completion = process.completion.then(
      exit => this._recordExit(session!, exit),
      error => this._failSession(session!, error),
    ).finally(() => {
      session!.completed = true
    })

    if (timeoutSeconds !== undefined) {
      session.timeout = setTimeout(() => {
        this._stop(session!, 'timedOut').catch((error) => {
          this._failSession(session!, error)
        })
      }, timeoutSeconds * 1000)
      session.timeout.unref()
    }

    return session
  }

  /**
   * 等待会话结束或本次等待到期
   */
  private async _wait(
    session: LocalShellSession,
    options: {
      signal?: AbortSignal
      yield?: number
      onOutput?: SandboxShellOutputHandler
    },
    defaultYieldSeconds: number,
  ) {
    const signal = options.signal
    const yieldSeconds = this._resolveYield(options.yield, defaultYieldSeconds)
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined

    if (signal?.aborted) {
      return this._takeResult(session)
    }

    session.onOutput = options.onOutput
    if (session.output && session.onOutput)
      this._queueProgress(session, session.onOutput, session.output)

    const yielded = new Promise<'yielded'>((resolve) => {
      waitTimer = setTimeout(resolve, yieldSeconds * 1000, 'yielded')
      waitTimer.unref()
    })
    const aborted = new Promise<'aborted'>((resolve) => {
      abortListener = () => resolve('aborted')
      signal?.addEventListener('abort', abortListener, { once: true })
    })

    try {
      const outcome = await Promise.race([
        session.completion.then(() => 'completed' as const),
        yielded,
        aborted,
      ])

      // 返回后仅缓存新输出
      session.onOutput = undefined

      if (outcome === 'aborted') {
        await session.progress
        return this._takeResult(session)
      }

      await session.progress

      if (session.failure) {
        if (session.status === 'running')
          await this._stop(session, 'terminated')
        this._sessions.delete(session.id)
        throw session.failure
      }

      return this._takeResult(session)
    }
    finally {
      if (waitTimer)
        clearTimeout(waitTimer)
      if (abortListener)
        signal?.removeEventListener('abort', abortListener)
      session.onOutput = undefined
    }
  }

  /**
   * 记录退出结果
   */
  private _recordExit(session: LocalShellSession, exit: LocalShellExit) {
    if (session.timeout)
      clearTimeout(session.timeout)
    if (session.status === 'running')
      session.status = 'exited'

    session.exitCode = exit.code
    session.signal = exit.signal ?? undefined
  }

  /**
   * 记录会话错误
   */
  private _failSession(session: LocalShellSession, error: unknown) {
    if (session.timeout)
      clearTimeout(session.timeout)
    if (session.status === 'running')
      session.status = 'exited'

    session.failure = error
  }

  /**
   * 终止进程，超时后强制结束
   */
  private async _stop(
    session: LocalShellSession,
    status: Extract<SandboxShellStatus, 'timedOut' | 'terminated'>,
  ) {
    if (session.status !== 'running') {
      await session.completion
      return
    }

    session.status = status
    await session.process.kill('SIGTERM')
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      session.completion.then(() => true),
      new Promise<boolean>((resolve) => {
        forceTimer = setTimeout(resolve, PROCESS_FORCE_KILL_TIMEOUT_MS, false)
        forceTimer.unref()
      }),
    ])

    if (forceTimer)
      clearTimeout(forceTimer)
    if (closed)
      return

    await session.process.kill('SIGKILL')
    await session.completion
  }

  /**
   * 返回并清空本次输出
   */
  private _takeResult(session: LocalShellSession): SandboxShellResult {
    const output = session.omittedBytes > 0
      ? `[已省略 ${session.omittedBytes} 字节较早输出]\n${session.output}`
      : session.output
    const result: SandboxShellResult = {
      status: session.status,
      output,
      exitCode: session.exitCode,
      signal: session.signal,
    }

    session.output = ''
    session.omittedBytes = 0

    if (session.status === 'running')
      result.sessionId = session.id
    else
      this._sessions.delete(session.id)

    return result
  }

  /**
   * 缓存并推送输出
   */
  private _appendOutput(session: LocalShellSession, output: string) {
    if (!output)
      return

    session.output += output
    const bytes = Buffer.byteLength(session.output)

    if (bytes > MAX_SESSION_OUTPUT_BYTES) {
      const encoded = Buffer.from(session.output)
      const omittedBytes = encoded.length - MAX_SESSION_OUTPUT_BYTES

      session.output = new TextDecoder().decode(encoded.subarray(omittedBytes))
      session.omittedBytes += omittedBytes
    }

    if (session.onOutput)
      this._queueProgress(session, session.onOutput, output)
  }

  /**
   * 串行执行输出回调
   */
  private _queueProgress(
    session: LocalShellSession,
    handler: SandboxShellOutputHandler,
    output: string,
  ) {
    session.progress = session.progress
      .then(() => handler(output))
      .then(() => undefined)
      .catch((error) => {
        session.failure ??= error
      })
  }

  /** -------------------- 进程方法 -------------------- */
  /**
   * 启动无 stdin 的普通 pipe 进程
   */
  private async _spawnPipe(
    shell: LocalShell,
    command: string,
    onOutput: (output: string) => void,
  ): Promise<LocalShellProcess> {
    const [program, ...args] = this._shellCommand(shell, command, false)
    const proc = crossSpawn(program, args, {
      cwd: this._cwd,
      detached: process.platform !== 'win32',
      env: this._env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    })
    const started = new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve)
      proc.once('error', reject)
    })
    const exited = new Promise<LocalShellExit>((resolve, reject) => {
      proc.once('error', reject)
      proc.once('close', (code, signal) => {
        resolve({ code, signal })
      })
    })
    const outputTasks = Promise.allSettled([
      this._readPipeOutput(proc.stdout, onOutput),
      this._readPipeOutput(proc.stderr, onOutput),
    ])
    const completion = exited.then(async (exit) => {
      throwSettledErrors(
        await outputTasks,
        'Shell 输出读取失败',
        true,
      )

      return exit
    })

    try {
      await started
    }
    catch (error) {
      await completion.catch(() => undefined)
      throw error
    }

    return {
      tty: false,
      completion,
      kill: signal => this._killPipeProcess(proc, signal),
    }
  }

  /**
   * 按需加载原生依赖并启动 PTY 进程
   */
  private async _spawnPty(
    shell: LocalShell,
    command: string,
    onOutput: (output: string) => void,
  ): Promise<LocalShellProcess> {
    const [program, ...args] = this._shellCommand(shell, command, true)
    const terminal = await this._pty.open({
      program,
      args,
      cwd: this._cwd,
      env: this._env,
      ...PTY_SIZE,
    })
    const subscription = this._pty.subscribe(terminal.id, 0, (event) => {
      if (event.type === 'output')
        onOutput(event.data)
    })

    for (const event of subscription.events) {
      if (event.type === 'output')
        onOutput(event.data)
    }

    const completion = terminal.completion.finally(() => {
      subscription.dispose()
      this._pty.release(terminal.id)
    })

    return {
      tty: true,
      completion,
      write: input => this._pty.write(terminal.id, input),
      kill: async (signal) => {
        await this._pty.kill(terminal.id, signal)
      },
    }
  }

  /**
   * 解码 pipe 输出并保持 stdout 与 stderr 的到达顺序
   */
  private async _readPipeOutput(
    stream: Readable | null,
    onOutput: (output: string) => void,
  ) {
    if (!stream)
      return

    const decoder = new TextDecoder()

    for await (const chunk of stream) {
      const output = decoder.decode(chunk, { stream: true })

      if (output)
        onOutput(output)
    }

    const tail = decoder.decode()

    if (tail)
      onOutput(tail)
  }

  /**
   * 向 pipe 进程组发送信号并兼容 Windows 进程树
   */
  private async _killPipeProcess(proc: ChildProcess, signal: NodeJS.Signals) {
    if (!proc.pid)
      return

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = nodeSpawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
          env: this._env,
          stdio: 'ignore',
          windowsHide: true,
        })

        killer.once('exit', () => resolve())
        killer.once('error', () => resolve())
      })
      return
    }

    try {
      process.kill(-proc.pid, signal)
    }
    catch {
      try {
        proc.kill(signal)
      }
      catch {
        // 忽略已退出进程
      }
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 按类型惰性解析并复用 Shell
   */
  private _resolveShell(kind: LocalShellKind) {
    const cached = this._shells.get(kind)

    if (cached)
      return cached

    if (!this._resolveLocalShell)
      throw new Error(`宿主未配置命令解释器解析能力: ${kind}`)
    const shell = this._resolveLocalShell(kind, this._env)

    this._shells.set(kind, shell)

    return shell
  }

  /**
   * 生成不同 Shell 的实际进程参数
   */
  private _shellCommand(
    shell: LocalShell,
    command: string,
    tty: boolean,
  ): [string, ...string[]] {
    if (shell.kind === 'cmd')
      return [shell.path, '/d', '/s', '/c', command]

    if (shell.kind === 'powershell' || shell.kind === 'pwsh') {
      return [
        shell.path,
        '-NoLogo',
        '-NoProfile',
        ...(tty ? [] : ['-NonInteractive']),
        '-Command',
        command,
      ]
    }

    return [shell.path, '-lc', command]
  }

  /**
   * 查找会话
   */
  private _session(sessionId: string) {
    const session = this._sessions.get(sessionId)

    if (!session)
      throw new Error(`Shell 会话不存在或已结束: ${sessionId}`)

    return session
  }

  /**
   * 独占会话
   */
  private _acquire(session: LocalShellSession) {
    if (session.busy)
      throw new Error(`Shell 会话正在被其他工具控制: ${session.id}`)

    session.busy = true
  }

  /**
   * 淘汰已结束会话
   */
  private _discardOldestCompletedSession() {
    if (this._sessions.size + this._opening.size < MAX_SHELL_SESSIONS)
      return

    const completed = [...this._sessions]
      .find(([, session]) => session.completed && !session.busy)

    if (completed)
      this._sessions.delete(completed[0])
  }

  /**
   * 校验调用状态
   */
  private _assertAvailable(signal?: AbortSignal) {
    if (this._closing)
      throw new Error('Shell 执行环境已经关闭')
    if (signal?.aborted)
      throw new Error('运行已中断')
  }

  /**
   * 解析命令超时
   */
  private _resolveTimeout(timeout?: number) {
    if (timeout === undefined)
      return
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('Shell 命令超时时间必须是正数')

    return Math.min(timeout, MAX_SANDBOX_SHELL_TIMEOUT_SECONDS)
  }

  /**
   * 解析等待时间
   */
  private _resolveYield(yieldSeconds: number | undefined, fallback: number) {
    if (
      typeof yieldSeconds !== 'number'
      || !Number.isFinite(yieldSeconds)
      || yieldSeconds <= 0
    ) {
      return fallback
    }

    return Math.min(
      Math.max(yieldSeconds, MIN_SANDBOX_SHELL_YIELD_SECONDS),
      MAX_SANDBOX_SHELL_YIELD_SECONDS,
    )
  }
}
