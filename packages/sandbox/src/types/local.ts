/** 已解析并冻结的完整执行环境 */
export type EnvVars = Readonly<Record<string, string>>

/** 本地命令解释器类型 */
export type LocalShellKind = 'bash' | 'cmd' | 'powershell' | 'pwsh' | 'sh' | 'zsh'

/** 已解析的本地命令解释器 */
export interface LocalShell {
  /** 命令语法类型 */
  readonly kind: LocalShellKind
  /** 实际执行程序 */
  readonly path: string
}

/** 宿主解析显式命令解释器的能力 */
export type LocalShellResolver = (kind: LocalShellKind, env: EnvVars) => LocalShell
