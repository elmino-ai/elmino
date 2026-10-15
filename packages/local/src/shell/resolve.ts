import type { EnvVars, LocalShell, LocalShellKind } from '@elmino/sandbox'
import os from 'node:os'
import { objectEntries } from '@elmino/shared'
import { findEnvExecutableSync } from '../process/process'

/** -------------------- 类型 -------------------- */
/** 用户级默认命令解释器选择 */
export type LocalShellPreference = 'auto' | LocalShellKind

/** 单个命令解释器的本机可用状态 */
export interface LocalShellAvailability {
  /** 命令语法类型 */
  kind: LocalShellKind
  /** 可用时的实际执行程序 */
  path?: string
}

/** 本地命令解释器探测参数 */
export interface LocalShellResolveOptions {
  /** 覆盖账户默认 Shell；null 表示不使用账户配置 */
  accountShell?: string | null
  /** 当前冻结的完整执行环境 */
  env: EnvVars
  /** 用户默认选择不可用时允许按平台顺序使用其他本机 Shell */
  fallback?: boolean
  /** 当前运行平台 */
  platform?: NodeJS.Platform
  /** 用户选择，缺省为自动 */
  preference?: LocalShellPreference
}

/** -------------------- 常量 -------------------- */
/** 各平台允许用户选择的命令解释器 */
const LOCAL_SHELL_KINDS: Record<
  Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>,
  readonly LocalShellKind[]
> = {
  darwin: ['zsh', 'bash', 'sh'],
  linux: ['bash', 'zsh', 'sh'],
  win32: ['pwsh', 'powershell', 'cmd'],
}

/** 不依赖 PATH 的常见安装位置 */
const LOCAL_SHELL_FALLBACK_PATHS: Record<LocalShellKind, Record<'posix' | 'win32', readonly string[]>> = {
  bash: { posix: ['/bin/bash', '/usr/bin/bash'], win32: [] },
  cmd: { posix: [], win32: [] },
  powershell: {
    posix: [],
    win32: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  },
  pwsh: {
    posix: ['/usr/local/bin/pwsh'],
    win32: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  },
  sh: { posix: ['/bin/sh'], win32: [] },
  zsh: { posix: ['/bin/zsh'], win32: [] },
}

/** -------------------- 核心函数 -------------------- */
/**
 * 列出当前平台允许选择的命令解释器及其真实路径
 */
export function listLocalShells(
  options: Omit<LocalShellResolveOptions, 'preference'>,
): LocalShellAvailability[] {
  const platform = options.platform ?? process.platform
  const accountShell = resolveAccountShell(options.accountShell, options.env, platform)

  return resolvePlatformKinds(platform).map((kind) => {
    const preferredPath = normalizeShellKind(accountShell) === kind
      ? accountShell ?? undefined
      : undefined
    const shell = resolveShell(kind, options.env, platform, preferredPath)

    return shell ?? { kind }
  })
}

/**
 * 按用户选择解析单个 Runtime 冻结的命令解释器
 */
export function resolveLocalShell(
  options: LocalShellResolveOptions,
): LocalShell {
  const platform = options.platform ?? process.platform
  const preference = options.preference ?? 'auto'
  const available = listLocalShells(options)

  if (preference !== 'auto') {
    if (!resolvePlatformKinds(platform).includes(preference))
      throw new Error(`当前平台不支持命令 Shell：${preference}`)

    const selected = available.find(shell => shell.kind === preference)

    if (selected?.path) {
      return Object.freeze({
        kind: selected.kind,
        path: selected.path,
      })
    }

    // 默认环境允许回退，工具显式指定 Shell 时仍严格检查，避免命令语法错配
    if (!options.fallback)
      throw new Error(`未找到已配置的命令 Shell：${preference}`)
  }

  const fallback = available.find((shell): shell is LocalShell => (
    typeof shell.path === 'string'
  ))

  if (fallback)
    return fallback

  if (preference !== 'auto')
    throw new Error(`未找到已配置的命令 Shell：${preference}`)

  throw new Error('当前系统没有可用的命令 Shell')
}

/** -------------------- 内部函数 -------------------- */
/**
 * 返回当前平台固定支持的命令解释器顺序
 */
function resolvePlatformKinds(platform: NodeJS.Platform) {
  if (platform === 'win32')
    return LOCAL_SHELL_KINDS.win32
  if (platform === 'darwin')
    return LOCAL_SHELL_KINDS.darwin
  return LOCAL_SHELL_KINDS.linux
}

/**
 * 解析账户默认 Shell，显式覆盖只用于测试与宿主注入
 */
function resolveAccountShell(
  override: string | null | undefined,
  env: EnvVars,
  platform: NodeJS.Platform,
) {
  if (override !== undefined)
    return override ?? undefined
  if (platform === 'win32')
    return undefined

  try {
    return os.userInfo().shell ?? env.SHELL
  }
  catch {
    return env.SHELL
  }
}

/**
 * 从最终 PATH、账户路径和平台固定位置解析指定 Shell
 */
function resolveShell(
  kind: LocalShellKind,
  env: EnvVars,
  platform: NodeJS.Platform,
  preferredPath?: string,
): LocalShell | undefined {
  const programs = kind === 'cmd'
    ? [resolveComSpec(env), 'cmd.exe']
    : [resolveProgram(kind, platform)]
  const platformKey = platform === 'win32' ? 'win32' : 'posix'

  for (const candidate of [
    preferredPath,
    ...programs,
    ...LOCAL_SHELL_FALLBACK_PATHS[kind][platformKey],
  ]) {
    if (!candidate)
      continue
    const shellPath = findEnvExecutableSync(candidate, env, platform)

    if (shellPath)
      return Object.freeze({ kind, path: shellPath })
  }

  return undefined
}

/**
 * 返回指定平台的标准程序名
 */
function resolveProgram(kind: LocalShellKind, platform: NodeJS.Platform) {
  if (platform !== 'win32')
    return kind
  if (kind === 'cmd')
    return 'cmd.exe'
  if (kind === 'powershell')
    return 'powershell.exe'
  if (kind === 'pwsh')
    return 'pwsh.exe'
  return kind
}

/**
 * 从 Windows 环境中按不区分大小写规则读取 ComSpec
 */
function resolveComSpec(env: EnvVars) {
  return objectEntries(env).find(([name]) => name.toLowerCase() === 'comspec')?.[1]
}

/**
 * 从程序名或路径识别受支持的 Shell 类型
 */
function normalizeShellKind(value: string | undefined): LocalShellKind | undefined {
  const name = value
    ?.trim()
    .toLowerCase()
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat)$/i, '')

  if (
    name === 'bash'
    || name === 'cmd'
    || name === 'powershell'
    || name === 'pwsh'
    || name === 'sh'
    || name === 'zsh'
  ) {
    return name
  }

  return undefined
}
