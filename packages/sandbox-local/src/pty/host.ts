import type { EnvVars } from '@elmino/sandbox'
import { Buffer } from 'node:buffer'
import { createId, throwSettledErrors } from '@elmino/shared'
import * as NodePty from '@lydell/node-pty'

/** -------------------- 类型 -------------------- */
/** PTY 终端尺寸 */
export interface LocalPtySize {
  /** 列数 */
  cols: number
  /** 行数 */
  rows: number
}

/** PTY 启动参数 */
export interface LocalPtyOpenOptions extends LocalPtySize {
  /** 启动参数 */
  args?: string[]
  /** 进程工作目录 */
  cwd: string
  /** 本次进程使用的完整环境变量 */
  env: EnvVars
  /** 实际执行程序 */
  program: string
}

/** PTY 退出结果 */
export interface LocalPtyExit {
  /** 退出码 */
  code: number | null
  /** 退出信号 */
  signal: string | null
}

/** PTY 输出事件 */
export interface LocalPtyOutputEvent {
  /** 单调递增事件游标 */
  cursor: number
  /** 输出内容 */
  data: string
  /** 事件类型 */
  type: 'output'
}

/** PTY 退出事件 */
export interface LocalPtyExitEvent extends LocalPtyExit {
  /** 单调递增事件游标 */
  cursor: number
  /** 事件类型 */
  type: 'exit'
}

/** PTY 可重放事件 */
export type LocalPtyEvent = LocalPtyExitEvent | LocalPtyOutputEvent

/** 写入游标前的 PTY 事件 */
type LocalPtyPendingEvent
  = | Omit<LocalPtyExitEvent, 'cursor'>
    | Omit<LocalPtyOutputEvent, 'cursor'>

/** PTY 会话句柄 */
export interface LocalPtyHandle {
  /** 退出结果 */
  completion: Promise<LocalPtyExit>
  /** 稳定会话 ID */
  id: string
}

/** PTY 事件快照 */
export interface LocalPtySnapshot {
  /** 当前最新游标 */
  cursor: number
  /** 游标之后的事件 */
  events: LocalPtyEvent[]
  /** 请求游标是否早于当前缓存 */
  truncated: boolean
}

/** PTY 事件订阅 */
export interface LocalPtySubscription extends LocalPtySnapshot {
  /** 取消实时订阅 */
  dispose: () => void
}

/** PTY 会话内部状态 */
interface LocalPtySession {
  /** 当前缓存字节数 */
  bytes: number
  /** 退出结果 */
  completion: Promise<LocalPtyExit>
  /** 当前最新游标 */
  cursor: number
  /** 有界事件缓存 */
  events: LocalPtyEvent[]
  /** 稳定会话 ID */
  id: string
  /** 实际 PTY 进程 */
  process: NodePty.IPty
  /** 是否已经退出 */
  completed: boolean
  /** 实时订阅者 */
  subscribers: Set<(event: LocalPtyEvent) => void>
}

/** -------------------- 常量 -------------------- */
/** PTY 会话上限 */
const MAX_PTY_SESSIONS = 64
/** 单会话输出缓存上限 */
const MAX_PTY_OUTPUT_BYTES = 1024 * 1024
/** 强制终止等待时间 */
const PROCESS_FORCE_KILL_TIMEOUT_MS = 3_000

/** -------------------- 核心类 -------------------- */
/**
 * 管理可复用、可重放的本地 PTY 会话
 */
export class LocalPtyHost {
  /** PTY 会话 */
  private readonly _sessions = new Map<string, LocalPtySession>()

  /** 正在启动的会话数 */
  private _openingSessions = 0

  /** 是否已经关闭 */
  private _disposed = false

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建 PTY 宿主
   */
  public static create() {
    return new LocalPtyHost()
  }

  /**
   * 启动一个交互 PTY 会话
   */
  public open(options: LocalPtyOpenOptions): LocalPtyHandle {
    if (this._disposed)
      throw new Error('PTY 宿主已经关闭')

    if (this._sessions.size + this._openingSessions >= MAX_PTY_SESSIONS) {
      throw new Error(
        `PTY 会话数已达上限（${MAX_PTY_SESSIONS}），请先关闭不再需要的终端`,
      )
    }

    this._openingSessions += 1
    try {
      const { args = [], cols, cwd, env, program, rows } = options
      const process = NodePty.spawn(program, args, {
        cols,
        cwd,
        env: { ...env, TERM: 'xterm-256color' },
        name: 'xterm-256color',
        rows,
      })
      const id = createId('terminal')
      let resolveCompletion: (exit: LocalPtyExit) => void = () => undefined
      const completion = new Promise<LocalPtyExit>((resolve) => {
        resolveCompletion = resolve
      })
      const session: LocalPtySession = {
        bytes: 0,
        completion,
        completed: false,
        cursor: 0,
        events: [],
        id,
        process,
        subscribers: new Set(),
      }
      this._sessions.set(id, session)
      process.onExit(({ exitCode, signal }) => {
        const exit = {
          code: exitCode,
          signal: signal ? String(signal) : null,
        }

        session.completed = true
        this._append(session, { type: 'exit', ...exit })
        resolveCompletion(exit)
      })
      process.onData(data => this._append(session, { type: 'output', data }))

      return { completion, id }
    }
    catch (error) {
      throw new Error('PTY 启动失败', { cause: error })
    }
    finally {
      this._openingSessions -= 1
    }
  }

  /**
   * 返回指定游标之后的缓存事件
   */
  public snapshot(sessionId: string, cursor = 0): LocalPtySnapshot {
    const session = this._session(sessionId)
    const first = session.events[0]?.cursor ?? session.cursor + 1
    const truncated = cursor < first - 1
    const events = session.events.filter(event => event.cursor > cursor)

    return { cursor: session.cursor, events, truncated }
  }

  /**
   * 原子获取缓存快照并订阅后续事件
   */
  public subscribe(
    sessionId: string,
    cursor: number,
    listener: (event: LocalPtyEvent) => void,
  ): LocalPtySubscription {
    const session = this._session(sessionId)
    const snapshot = this.snapshot(sessionId, cursor)

    session.subscribers.add(listener)

    return {
      ...snapshot,
      dispose: () => session.subscribers.delete(listener),
    }
  }

  /**
   * 向 PTY 写入用户输入
   */
  public write(sessionId: string, input: string) {
    const session = this._session(sessionId)

    if (!session.completed)
      session.process.write(input)
  }

  /**
   * 调整 PTY 终端尺寸
   */
  public resize(sessionId: string, size: LocalPtySize) {
    const session = this._session(sessionId)

    if (!session.completed)
      session.process.resize(size.cols, size.rows)
  }

  /**
   * 请求终止 PTY 进程但保留会话缓存
   */
  public async kill(sessionId: string, signal: NodeJS.Signals = 'SIGTERM') {
    const session = this._session(sessionId)

    if (session.completed)
      return session.completion

    this._kill(session, signal)
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
    if (!closed) {
      this._kill(session, 'SIGKILL')
      await session.completion
    }

    return session.completion
  }

  /**
   * 关闭并移除一个 PTY 会话
   */
  public async close(sessionId: string) {
    const session = this._session(sessionId)

    if (!session.completed)
      await this.kill(sessionId)
    else
      await session.completion

    this.release(sessionId)
  }

  /**
   * 释放已经结束的 PTY 会话缓存
   */
  public release(sessionId: string) {
    const session = this._sessions.get(sessionId)

    if (!session)
      return
    if (!session.completed)
      throw new Error(`PTY 会话仍在运行: ${sessionId}`)

    session.subscribers.clear()
    this._sessions.delete(sessionId)
  }

  /**
   * 关闭全部 PTY 会话
   */
  public async dispose() {
    if (this._disposed)
      return

    this._disposed = true
    const sessions = [...this._sessions.values()]
    const results = await Promise.allSettled(sessions.map(async (session) => {
      if (!session.completed)
        await this.kill(session.id)
      else
        await session.completion
    }))

    for (const session of sessions)
      session.subscribers.clear()
    this._sessions.clear()
    throwSettledErrors(results, '关闭 PTY 会话失败')
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 追加有界事件并通知实时订阅者
   */
  private _append(
    session: LocalPtySession,
    event: LocalPtyPendingEvent,
  ) {
    const next = { ...event, cursor: session.cursor + 1 } as LocalPtyEvent

    session.cursor = next.cursor
    session.events.push(next)
    session.bytes += next.type === 'output' ? Buffer.byteLength(next.data) : 0

    while (session.bytes > MAX_PTY_OUTPUT_BYTES) {
      const removed = session.events.shift()

      if (!removed)
        break
      if (removed.type === 'output')
        session.bytes -= Buffer.byteLength(removed.data)
    }

    for (const subscriber of session.subscribers)
      subscriber(next)
  }

  /**
   * 向平台 PTY 发送终止信号
   */
  private _kill(session: LocalPtySession, signal: NodeJS.Signals) {
    try {
      if (process.platform === 'win32')
        session.process.kill()
      else
        session.process.kill(signal)
    }
    catch {
      // 进程已退出时终止操作保持幂等
    }
  }

  /**
   * 返回指定 PTY 会话
   */
  private _session(sessionId: string) {
    const session = this._sessions.get(sessionId)

    if (!session)
      throw new Error(`PTY 会话不存在: ${sessionId}`)

    return session
  }
}
