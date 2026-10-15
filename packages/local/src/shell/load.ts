import type { EnvVars } from '@elmino/sandbox'
import type { LoadUserEnvOptions } from '../env/types'
import os from 'node:os'
import { objectKeys } from '@elmino/shared'
import { createEnv } from '../env/env'
import { runEnvCommand } from '../process/process'

/** -------------------- 常量 -------------------- */
/** 登录 Shell 环境输出标记 */
const ENV_MARKER = '__ELMINO_USER_ENV__'
/** 登录 Shell 输出完整环境的脚本 */
const ENV_SCRIPT = `printf '\\0${ENV_MARKER}\\0'; env -0; printf '\\0${ENV_MARKER}\\0'`
/** 用户 Shell 环境读取超时 */
const ENV_TIMEOUT_MS = 10_000
/** POSIX Shell 启动前使用的干净系统 PATH */
const POSIX_BOOTSTRAP_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** 不允许污染登录 Shell 初始化判断的临时激活变量 */
const ACTIVATION_VARIABLE_PATTERN = /^(?:CONDA(?:_.+)?|_CE_(?:CONDA|M)|VIRTUAL_ENV(?:_PROMPT)?|PYENV_VERSION)$/

/** -------------------- 核心函数 -------------------- */
/**
 * 通过账户默认 Shell 的原生启动规则读取用户环境
 */
export async function loadUserEnv(
  options: LoadUserEnvOptions = {},
): Promise<EnvVars> {
  const platform = options.platform ?? process.platform
  const inherited = options.env ?? process.env

  if (platform === 'win32')
    return createEnv(inherited)

  const shellPath = options.shellPath ?? resolveAccountShell(platform, inherited)
  const bootstrap = createBootstrapEnv(inherited)

  if (!shellPath)
    return createEnv(bootstrap)

  try {
    const { stdout } = await runEnvCommand(shellPath, ['-lic', ENV_SCRIPT], {
      env: createEnv(bootstrap),
      platform,
      timeoutMs: options.timeoutMs ?? ENV_TIMEOUT_MS,
      spawn: options.spawn,
    })
    return extractEnv(stdout) ?? createEnv(bootstrap)
  }
  catch (error) {
    if (error instanceof AggregateError)
      throw error
    return createEnv(bootstrap)
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 解析账户 Shell 并按平台提供固定回退
 */
function resolveAccountShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  let accountShell: string | undefined

  try {
    accountShell = os.userInfo().shell ?? undefined
  }
  catch {
    accountShell = undefined
  }

  return accountShell
    ?? env.SHELL
    ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/**
 * 保留宿主会话变量并清除继承来的运行环境激活状态
 */
function createBootstrapEnv(env: NodeJS.ProcessEnv) {
  const bootstrap: NodeJS.ProcessEnv = { ...env, PATH: POSIX_BOOTSTRAP_PATH }

  for (const name of objectKeys(bootstrap)) {
    if (ACTIVATION_VARIABLE_PATTERN.test(name))
      delete bootstrap[name]
  }

  return bootstrap
}

/**
 * 使用 NUL 分隔记录保留换行、等号和尾部空格，标记与环境值不会混淆
 */
function extractEnv(stdout: string) {
  const parts = stdout.split(`\0${ENV_MARKER}\0`)
  const content = parts.length >= 3 ? parts.at(-2) : undefined

  if (!content)
    return undefined

  const variables = Object.create(null) as Record<string, string>

  for (const line of content.split('\0')) {
    const separator = line.indexOf('=')

    if (separator <= 0)
      continue

    variables[line.slice(0, separator)] = line.slice(separator + 1)
  }

  return variables.PATH ? createEnv(variables) : undefined
}
