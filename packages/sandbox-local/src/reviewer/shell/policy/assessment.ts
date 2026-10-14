import type { ShellCommandAssessment, ShellReviewContext } from './types'
import { SHELL_COMMAND_POLICIES } from './registry'
import { assessDirectScriptCommand } from './specialized'

/** -------------------- 常量 -------------------- */
/** 不具备加载或命令注入能力的 POSIX 环境前缀 */
const SAFE_ENV_KEYS = new Set([
  'CGO_ENABLED',
  'CI',
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'DOTNET_NOLOGO',
  'FORCE_COLOR',
  'GOARCH',
  'GOOS',
  'NODE_ENV',
  'NO_COLOR',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED',
  'RUST_BACKTRACE',
])

/** 会改变可执行文件、运行库或语言加载来源的环境变量 */
const INJECTION_ENV_PATTERN = /^(?:PATH|LD_.+|DYLD_.+|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|GRADLE_OPTS|MAVEN_OPTS|RUBYOPT|PERL5OPT|PERL5LIB|BASH_ENV|ENV|PROMPT_COMMAND)$/i

/** -------------------- 核心函数 -------------------- */
/**
 * 按唯一策略表评估单条已解析命令
 */
export function assessShellCommand(
  executable: string,
  args: string[],
  context: ShellReviewContext,
  windowsStyle = false,
): ShellCommandAssessment {
  const env = stripEnvPrefixes([executable, ...args])

  if ('assessment' in env)
    return env.assessment

  const [resolvedExecutable, ...resolvedArgs] = env.args
  const name = commandName(resolvedExecutable!, windowsStyle)
  const policy = SHELL_COMMAND_POLICIES.find(item => item.executables.some(candidate => (
    typeof candidate === 'string'
      ? candidate === name
      : candidate.test(name)
  )))

  if (policy)
    return policy.assess(resolvedArgs, context)

  const scriptAssessment = assessDirectScriptCommand(resolvedExecutable!, context)

  return scriptAssessment ?? {
    category: 'unknown',
    reason: `命令 ${resolvedExecutable} 未在受限开发命令策略表内`,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 归一化可执行文件 basename
 */
function commandName(name: string, windowsStyle: boolean) {
  const basename = name.split(/[\\/]/).at(-1) || name
  const normalized = windowsStyle ? basename.toLowerCase() : basename

  return windowsStyle
    ? normalized.replace(/\.(?:exe|cmd|bat|com)$/i, '')
    : normalized
}

/**
 * 读取并校验命令前的环境变量赋值
 */
function stripEnvPrefixes(args: string[]): { args: string[] } | { assessment: ShellCommandAssessment } {
  let index = 0

  while (index < args.length) {
    const match = /^([a-z_]\w*)=(.*)$/is.exec(args[index]!)

    if (!match)
      break

    const [, key = '', value = ''] = match

    if (INJECTION_ENV_PATTERN.test(key)) {
      return {
        assessment: {
          category: 'dangerous',
          reason: `环境变量 ${key} 会改变命令或运行库加载来源`,
        },
      }
    }

    if (!SAFE_ENV_KEYS.has(key)) {
      return {
        assessment: {
          category: 'unknown',
          reason: `环境变量 ${key} 未在受限环境前缀内`,
        },
      }
    }

    if (!/^[\w./:+,-]*$/.test(value)) {
      return {
        assessment: {
          category: 'unknown',
          reason: `环境变量 ${key} 的值无法安全解析`,
        },
      }
    }

    index++
  }

  if (index === args.length) {
    return {
      assessment: {
        category: 'unknown',
        reason: '命令仅包含环境变量赋值',
      },
    }
  }

  return { args: args.slice(index) }
}
