import type { LocalSandboxOptions } from '@elmino/sandbox-local'
import { LocalSandbox } from '@elmino/sandbox-local'

type EnvVars = LocalSandboxOptions['env']
type LocalShell = LocalSandboxOptions['shell']
type LocalShellKind = LocalShell['kind']

/** 当前测试进程已提供的环境，不读取产品配置或用户认证 */
export const TEST_ENV: EnvVars = Object.freeze(Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
))

/** 测试本地沙箱的显式环境参数 */
interface TestSandboxOptions extends Omit<LocalSandboxOptions, 'env' | 'shell'> {
  /** 当前测试用例覆盖的环境 */
  env?: EnvVars
  /** 显式选择测试命令语法 */
  shell?: LocalShellKind
}

/**
 * 提供测试需要的命令解释器位置
 */
function resolveShell(kind: LocalShellKind): LocalShell {
  return {
    kind,
    path: process.platform === 'win32'
      ? kind === 'cmd' ? process.env.ComSpec ?? 'cmd.exe' : `${kind}.exe`
      : `/bin/${kind}`,
  }
}

/**
 * 以参数注入临时工作目录、环境和命令解释器，不读取产品运行数据
 */
export function createTestSandbox(input: string | TestSandboxOptions) {
  const options = typeof input === 'string' ? { cwd: input } : input
  const kind = options.shell ?? (process.platform === 'win32' ? 'cmd' : 'sh')

  return LocalSandbox.create({
    ...options,
    env: options.env ?? TEST_ENV,
    shell: resolveShell(kind),
    resolveShell,
  })
}
