import type { ShellCommandPolicy } from './types'

/** -------------------- 类型 -------------------- */
/** 固定子命令工具的分类配置 */
export interface FixedCommandPolicyConfig {
  /** 纯查询子命令 */
  query?: readonly string[]
  /** 静态检查子命令 */
  check?: readonly string[]
  /** 测试子命令 */
  test?: readonly string[]
  /** 构建子命令 */
  build?: readonly string[]
  /** 会执行受信任项目代码的固定子命令 */
  trusted?: readonly string[]
  /** 锁定依赖恢复子命令 */
  locked?: Readonly<Record<string, readonly string[]>>
  /** 仅带检查参数时允许的格式化子命令 */
  checkedFormat?: readonly string[]
  /** 明确修改本地状态的子命令 */
  mutation?: readonly string[]
  /** 明确修改外部状态的子命令 */
  external?: readonly string[]
}

/** 固定子命令工具的额外约束 */
export interface FixedCommandPolicyConstraints {
  /** 没有子命令时的固定分类 */
  allowWithoutSubcommand?: 'query' | 'check'
  /** 指定子命令必须携带锁文件参数 */
  requireLockedFor?: readonly string[]
  /** 指定检查子命令至少需要命中一个只检查参数 */
  checkFlags?: Readonly<Record<string, readonly string[]>>
}

/** -------------------- 核心函数 -------------------- */
/**
 * 创建所有工具链共享的固定子命令策略
 */
export function createSubcommandPolicy(
  id: string,
  executables: ShellCommandPolicy['executables'],
  config: FixedCommandPolicyConfig,
  constraints: FixedCommandPolicyConstraints = {},
): ShellCommandPolicy {
  return {
    id,
    executables,
    assess: (args) => {
      if (isVersionOrHelpQuery(args))
        return { category: 'query' }

      const subcommand = args.find(arg => !arg.startsWith('-'))

      if (!subcommand) {
        return constraints.allowWithoutSubcommand
          ? { category: constraints.allowWithoutSubcommand }
          : unknown(`${id} 命令缺少可确认的子命令`)
      }
      if (config.mutation?.includes(subcommand) || args.some(arg => config.mutation?.includes(arg))) {
        return {
          category: 'mutation',
          reason: `${id} ${subcommand} 会修改项目、工具链或本地状态`,
        }
      }
      if (config.external?.includes(subcommand) || args.some(arg => config.external?.includes(arg))) {
        return {
          category: 'externalEffect',
          reason: `${id} ${subcommand} 会修改远端或外部状态`,
        }
      }

      const lockedFlags = config.locked?.[subcommand]

      if (lockedFlags) {
        return lockedFlags.every(flag => hasOption(args, [flag]))
          ? { category: 'lockedRestore' }
          : {
              category: 'mutation',
              reason: `${id} ${subcommand} 缺少锁定恢复参数 ${lockedFlags.join(' ')}`,
            }
      }

      const checkedFormat = config.checkedFormat?.includes(subcommand)
      const checkFlags = constraints.checkFlags?.[subcommand]
        ?? (checkedFormat ? ['--check', '-check'] : undefined)

      if (checkFlags && !checkFlags.some(flag => args.includes(flag))) {
        return {
          category: 'mutation',
          reason: `${id} ${subcommand} 缺少只检查参数`,
        }
      }
      if (constraints.requireLockedFor?.includes(subcommand) && !args.includes('--locked')) {
        return {
          category: 'mutation',
          reason: `${id} ${subcommand} 必须使用 --locked`,
        }
      }
      if (checkedFormat)
        return { category: 'check' }
      if (config.query?.includes(subcommand))
        return { category: 'query' }
      if (config.check?.includes(subcommand))
        return { category: 'check' }
      if (config.test?.includes(subcommand))
        return { category: 'test' }
      if (config.build?.includes(subcommand))
        return { category: 'build' }
      if (config.trusted?.includes(subcommand))
        return { category: 'trustedExecution' }

      return unknown(`${id} ${subcommand} 未在固定子命令策略内`)
    },
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断 argv 是否仅请求版本或帮助
 */
function isVersionOrHelpQuery(args: string[]) {
  return args.length > 0 && args.every(arg => (
    ['-?', '-V', '-h', '--help', '--version', '-help', '-version', 'help', 'version'].includes(arg)
    || arg.startsWith('--help=')
  ))
}

/**
 * 判断 argv 是否包含 option 或等号形式
 */
function hasOption(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => arg === option || arg.startsWith(`${option}=`)))
}

/**
 * 创建未知评估
 */
function unknown(reason: string) {
  return { category: 'unknown' as const, reason }
}
