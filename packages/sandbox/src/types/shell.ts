import type { Promisable } from '@elmino/shared'
import type { LocalShellKind } from './local'

/** -------------------- 类型 -------------------- */
/** Shell 会话状态 */
export type SandboxShellStatus
  = | 'running'
    | 'exited'
    | 'timedOut'
    | 'terminated'

/** Shell 输出增量处理器 */
export type SandboxShellOutputHandler = (
  chunk: string,
) => Promisable<void>

/** Shell 调用结果 */
export interface SandboxShellResult {
  /** 当前进程状态 */
  status: SandboxShellStatus
  /** 本次新增输出 */
  output: string
  /** 运行中会话 ID */
  sessionId?: string
  /** 进程退出码 */
  exitCode?: number | null
  /** 进程退出信号 */
  signal?: string
}

/** 命令执行选项 */
export interface SandboxRunOptions {
  /** 命令使用的 shell，不传时使用本地默认 shell */
  shell?: LocalShellKind
  /** 取消调用，不终止已启动的进程 */
  signal?: AbortSignal
  /** 命令总超时（秒），不传则不限时 */
  timeout?: number
  /** 本次等待输出的最长时间，单位秒 */
  yield?: number
  /** 是否为命令分配伪终端 */
  tty?: boolean
  /** 命令输出增量回调，stdout 和 stderr 都会归一到同一条输出流 */
  onOutput?: SandboxShellOutputHandler
}

/** 已有 Shell 会话写入选项 */
export interface SandboxShellWriteOptions {
  /** 写入 PTY 的字符；省略或为空时只轮询输出 */
  input?: string
  /** 取消调用，不终止已启动的进程 */
  signal?: AbortSignal
  /** 本次等待输出的最长时间，单位秒 */
  yield?: number
  /** 命令输出增量回调 */
  onOutput?: SandboxShellOutputHandler
}

/** Shell 命令审批预检输入 */
export interface SandboxShellReviewInput {
  /** Shell 动作类型 */
  kind: 'shell'
  /** 命令使用的 shell，不传时使用本地默认 shell */
  shell?: LocalShellKind
  /** 要评审的命令文本 */
  command?: string
}

/** 沙箱命令执行能力 */
export interface SandboxShell {
  /** 执行 shell 命令 */
  run: (
    command: string,
    options?: SandboxRunOptions,
  ) => Promise<SandboxShellResult>
  /** 写入或轮询已有 shell 会话 */
  write: (
    sessionId: string,
    options?: SandboxShellWriteOptions,
  ) => Promise<SandboxShellResult>
  /** 终止已有 shell 会话 */
  terminate: (sessionId: string) => Promise<SandboxShellResult>
  /** 关闭全部会话 */
  dispose: () => Promise<void>
}
