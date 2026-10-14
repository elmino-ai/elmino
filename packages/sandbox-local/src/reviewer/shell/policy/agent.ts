import type { ShellCommandAssessment, ShellCommandPolicy, ShellReviewContext } from './types'
import { objectEntries } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 单个 CLI 的参数解析约束 */
interface AgentCliArgumentSpec {
  /** 不携带值的安全参数 */
  booleanOptions: readonly string[]
  /** 携带普通值的安全参数 */
  valueOptions: readonly string[]
  /** 携带路径值的安全参数及其符号链接处理方式 */
  pathOptions?: Readonly<Record<string, boolean>>
  /** 值可省略的安全参数 */
  optionalValueOptions?: readonly string[]
  /** 允许使用紧凑值形式的短参数 */
  compactOptions?: readonly string[]
}

/** 已解析的 CLI 参数 */
interface ParsedAgentCliArguments {
  /** 非 option 参数 */
  positionals: string[]
  /** 按规范 option 名聚合的值 */
  values: Map<string, string[]>
}

/** -------------------- 常量 -------------------- */
/** 仅用于帮助或版本查询的参数 */
const HELP_VERSION_ARGS = new Set(['-?', '-V', '-h', '--help', '--version', 'help', 'version'])

/** Codex 会扩张沙箱、注入配置或触发外部操作的参数 */
const CODEX_DENIED_OPTIONS = [
  '--add-dir',
  '--config',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--disable',
  '--enable',
  '--full-auto',
  '--ignore-rules',
  '--profile',
  '--remote',
  '--remote-auth-token-env',
  '--search',
  '--yolo',
  '-c',
  '-p',
] as const

/** Codex 不属于本地只读会话的管理和服务子命令 */
const CODEX_DENIED_COMMANDS = new Set([
  'app-server',
  'apply',
  'archive',
  'cloud',
  'completion',
  'debug',
  'delete',
  'execpolicy',
  'features',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'sandbox',
  'unarchive',
])

/** Aider 会编辑、执行命令、加载配置或安装组件的参数 */
const AIDER_DENIED_OPTIONS = [
  '--api-key',
  '--apply',
  '--apply-clipboard-edits',
  '--architect',
  '--auto-accept-architect',
  '--auto-commits',
  '--auto-lint',
  '--auto-test',
  '--browser',
  '--commit',
  '--commit-prompt',
  '--config',
  '--env-file',
  '--file',
  '--gui',
  '--install-main-branch',
  '--lint',
  '--lint-cmd',
  '--load',
  '--model-metadata-file',
  '--model-settings-file',
  '--notifications-command',
  '--set-env',
  '--test',
  '--test-cmd',
  '--upgrade',
  '--watch-files',
  '--yes-always',
  '-c',
  '-y',
] as const

/** OpenCode 会自动批准、共享会话、启动服务或选择自定义命令的参数 */
const OPENCODE_DENIED_OPTIONS = [
  '--attach',
  '--auto',
  '--command',
  '--cors',
  '--hostname',
  '--mdns',
  '--port',
  '--share',
] as const

/** OpenCode 不属于本地 Plan 会话的管理和服务子命令 */
const OPENCODE_DENIED_COMMANDS = new Set([
  'acp',
  'agent',
  'attach',
  'auth',
  'export',
  'github',
  'import',
  'mcp',
  'pr',
  'serve',
  'uninstall',
  'upgrade',
  'web',
])

/** Claude 会绕过权限、注入扩展配置或启动远端能力的参数 */
const CLAUDE_DENIED_OPTIONS = [
  '--add-dir',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowed-tools',
  '--allowedTools',
  '--append-system-prompt-file',
  '--bg',
  '--cloud',
  '--dangerously-skip-permissions',
  '--debug-file',
  '--mcp-config',
  '--permission-prompt-tool',
  '--plugin-dir',
  '--remote-control',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--system-prompt-file',
  '--tools',
] as const

/** Claude 不属于本地 Plan 会话的管理和服务子命令 */
const CLAUDE_DENIED_COMMANDS = new Set([
  'agents',
  'auth',
  'daemon',
  'doctor',
  'install',
  'mcp',
  'plugin',
  'remote-control',
  'setup-token',
  'update',
  'upgrade',
])

/** -------------------- 策略注册 -------------------- */
/**
 * 创建显式只读 Agent CLI 策略
 */
export function createAgentCliPolicies(): ShellCommandPolicy[] {
  return [
    {
      id: 'codex-read-only-agent',
      executables: ['codex'],
      assess: (args, context) => assessCodex(args, context),
    },
    {
      id: 'aider-ask-agent',
      executables: ['aider'],
      assess: (args, context) => assessAider(args, context),
    },
    {
      id: 'opencode-plan-agent',
      executables: ['opencode', 'opencode2'],
      assess: (args, context) => assessOpenCode(args, context),
    },
    {
      id: 'claude-plan-agent',
      executables: ['claude'],
      assess: (args, context) => assessClaude(args, context),
    },
  ]
}

/** -------------------- 内部函数 -------------------- */
/**
 * 评估显式启用 read-only 沙箱的 Codex 会话
 */
function assessCodex(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, CODEX_DENIED_OPTIONS))
    return mutation('Codex 参数会扩张沙箱、注入配置或触发管理操作')

  const parsed = parseAgentCliArguments(args, context, {
    booleanOptions: [
      '--all',
      '--ephemeral',
      '--full-stdout',
      '--help',
      '--json',
      '--last',
      '--no-alt-screen',
      '--oss',
      '--skip-git-repo-check',
      '--uncommitted',
      '--version',
      '-?',
      '-V',
      '-h',
    ],
    valueOptions: [
      '--ask-for-approval',
      '--base',
      '--color',
      '--commit',
      '--local-provider',
      '--model',
      '--sandbox',
      '--title',
      '-a',
      '-m',
      '-s',
    ],
    pathOptions: {
      '--cd': true,
      '--image': true,
      '--output-last-message': false,
      '--output-schema': true,
      '-C': true,
      '-i': true,
      '-o': false,
    },
    compactOptions: ['-C', '-i', '-m', '-o', '-s'],
  })

  if ('assessment' in parsed)
    return parsed.assessment

  const command = parsed.positionals[0]

  if (command && CODEX_DENIED_COMMANDS.has(command))
    return external(`Codex ${command} 不属于本地只读会话`)

  const sandboxes = readParsedValues(parsed, ['--sandbox', '-s'])

  if (sandboxes.length === 0 || sandboxes.some(value => value !== 'read-only'))
    return mutation('Codex 必须显式且仅使用 --sandbox read-only')

  return { category: 'trustedExecution' }
}

/**
 * 评估显式启用 ask 模式的 Aider 会话
 */
function assessAider(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, AIDER_DENIED_OPTIONS) || args.some(arg => /api-key/i.test(optionName(arg))))
    return mutation('Aider 参数会编辑项目、执行命令、加载配置或安装组件')

  const parsed = parseAgentCliArguments(args, context, {
    booleanOptions: [
      '--analytics-disable',
      '--dry-run',
      '--help',
      '--just-check-update',
      '--no-auto-commits',
      '--no-cache-prompts',
      '--no-check-update',
      '--no-detect-urls',
      '--no-fancy-input',
      '--no-git',
      '--no-gitignore',
      '--no-multiline',
      '--no-pretty',
      '--no-show-model-warnings',
      '--no-stream',
      '--no-suggest-shell-commands',
      '--no-verify-ssl',
      '--show-prompts',
      '--show-release-notes',
      '--show-repo-map',
      '--verbose',
      '--verify-ssl',
      '--version',
      '-h',
      '-v',
    ],
    valueOptions: [
      '--chat-mode',
      '--code-theme',
      '--edit-format',
      '--editor-model',
      '--encoding',
      '--list-models',
      '--map-refresh',
      '--map-tokens',
      '--message',
      '--model',
      '--reasoning-effort',
      '--thinking-tokens',
      '--timeout',
      '--tool-error-color',
      '--tool-output-color',
      '--tool-warning-color',
      '--user-input-color',
      '--weak-model',
      '-m',
    ],
    pathOptions: {
      '--message-file': true,
      '--read': true,
      '-f': true,
    },
    compactOptions: ['-f', '-m'],
  })

  if ('assessment' in parsed)
    return parsed.assessment

  const modes = readParsedValues(parsed, ['--chat-mode', '--edit-format'])

  if (modes.length === 0 || modes.some(value => value !== 'ask'))
    return mutation('Aider 必须显式且仅使用 ask 会话模式')

  const outside = parsed.positionals.find(value => !context.containsPath(value, true))

  return outside
    ? mutation('Aider 位置参数必须是可信根内的项目文件')
    : { category: 'trustedExecution' }
}

/**
 * 评估显式选择 plan agent 的 OpenCode 会话
 */
function assessOpenCode(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, OPENCODE_DENIED_OPTIONS))
    return external('OpenCode 参数会自动批准权限、共享会话、启动服务或执行自定义命令')

  const parsed = parseAgentCliArguments(args, context, {
    booleanOptions: [
      '--continue',
      '--fork',
      '--help',
      '--print-logs',
      '--pure',
      '--thinking',
      '--version',
      '-c',
      '-h',
      '-V',
    ],
    valueOptions: [
      '--agent',
      '--format',
      '--log-level',
      '--model',
      '--prompt',
      '--session',
      '--title',
      '--variant',
      '-m',
      '-s',
    ],
    pathOptions: {
      '--dir': true,
      '--file': true,
      '-f': true,
    },
    compactOptions: ['-f', '-m', '-s'],
  })

  if ('assessment' in parsed)
    return parsed.assessment

  const agents = readParsedValues(parsed, ['--agent'])

  if (agents.length === 0 || agents.some(value => value !== 'plan'))
    return mutation('OpenCode 必须显式且仅使用 plan agent')

  const command = parsed.positionals[0]

  if (command && OPENCODE_DENIED_COMMANDS.has(command))
    return external(`OpenCode ${command} 不属于本地 Plan 会话`)
  if (command === 'run')
    return { category: 'trustedExecution' }
  if (command && !context.containsPath(command, true))
    return mutation('OpenCode 项目位置必须位于可信根内')

  return { category: 'trustedExecution' }
}

/**
 * 评估显式启用 plan 权限模式的 Claude 会话
 */
function assessClaude(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, CLAUDE_DENIED_OPTIONS))
    return mutation('Claude 参数会绕过权限、注入扩展配置或启动远端能力')

  const parsed = parseAgentCliArguments(args, context, {
    booleanOptions: [
      '--continue',
      '--disable-slash-commands',
      '--fork-session',
      '--help',
      '--include-partial-messages',
      '--no-session-persistence',
      '--print',
      '--replay-user-messages',
      '--verbose',
      '--version',
      '-c',
      '-h',
      '-p',
      '-v',
    ],
    valueOptions: [
      '--betas',
      '--effort',
      '--fallback-model',
      '--from-pr',
      '--input-format',
      '--json-schema',
      '--max-budget-usd',
      '--max-turns',
      '--model',
      '--output-format',
      '--permission-mode',
      '--session-id',
    ],
    optionalValueOptions: ['--resume', '-r'],
  })

  if ('assessment' in parsed)
    return parsed.assessment

  const modes = readParsedValues(parsed, ['--permission-mode'])

  if (modes.length === 0 || modes.some(value => value !== 'plan'))
    return mutation('Claude 必须显式且仅使用 plan 权限模式')

  const command = parsed.positionals[0]

  return command && CLAUDE_DENIED_COMMANDS.has(command)
    ? external(`Claude ${command} 不属于本地 Plan 会话`)
    : { category: 'trustedExecution' }
}

/**
 * 按单个 Agent CLI 的参数规范解析 option、路径和位置参数
 */
function parseAgentCliArguments(
  args: string[],
  context: ShellReviewContext,
  spec: AgentCliArgumentSpec,
): ParsedAgentCliArguments | { assessment: ShellCommandAssessment } {
  const booleanOptions = new Set(spec.booleanOptions)
  const valueOptions = new Set(spec.valueOptions)
  const pathOptions = new Map(objectEntries(spec.pathOptions ?? {}))
  const optionalValueOptions = new Set(spec.optionalValueOptions ?? [])
  const compactOptions = [...(spec.compactOptions ?? [])].sort((left, right) => right.length - left.length)
  const values = new Map<string, string[]>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if (arg === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    if (booleanOptions.has(arg))
      continue

    const equalsIndex = arg.indexOf('=')
    const equalsOption = equalsIndex > 0 ? arg.slice(0, equalsIndex) : ''

    if (equalsOption && (valueOptions.has(equalsOption) || pathOptions.has(equalsOption) || optionalValueOptions.has(equalsOption))) {
      const value = arg.slice(equalsIndex + 1)
      const assessment = appendOptionValue(values, equalsOption, value, context, pathOptions)

      if (assessment)
        return { assessment }
      continue
    }

    const compactOption = compactOptions.find(option => arg.startsWith(option) && arg.length > option.length)

    if (compactOption) {
      const assessment = appendOptionValue(values, compactOption, arg.slice(compactOption.length), context, pathOptions)

      if (assessment)
        return { assessment }
      continue
    }

    if (optionalValueOptions.has(arg)) {
      const next = args[index + 1]

      if (next && !next.startsWith('-')) {
        appendValue(values, arg, next)
        index++
      }
      continue
    }

    if (valueOptions.has(arg) || pathOptions.has(arg)) {
      const value = args[index + 1]

      if (!value)
        return { assessment: unknown(`Agent CLI 参数 ${arg} 缺少值`) }

      const assessment = appendOptionValue(values, arg, value, context, pathOptions)

      if (assessment)
        return { assessment }
      index++
      continue
    }

    return { assessment: unknown(`Agent CLI 参数 ${optionName(arg)} 未在显式只读模式策略内`) }
  }

  return { positionals, values }
}

/**
 * 保存 option 值并校验路径参数的可信根边界
 */
function appendOptionValue(
  values: Map<string, string[]>,
  option: string,
  value: string,
  context: ShellReviewContext,
  pathOptions: ReadonlyMap<string, boolean>,
) {
  if (!value)
    return unknown(`Agent CLI 参数 ${option} 缺少值`)

  const followLeaf = pathOptions.get(option)

  if (followLeaf !== undefined && !context.containsPath(value, followLeaf))
    return mutation(`Agent CLI 路径参数 ${option} 不在可信根内`)

  appendValue(values, option, value)
  return undefined
}

/**
 * 将重复 option 值追加到同一参数名下
 */
function appendValue(values: Map<string, string[]>, option: string, value: string) {
  const current = values.get(option) ?? []

  current.push(value)
  values.set(option, current)
}

/**
 * 读取多个同义 option 的全部已解析值
 */
function readParsedValues(parsed: ParsedAgentCliArguments, options: readonly string[]) {
  return options.flatMap(option => parsed.values.get(option) ?? [])
}

/**
 * 判断 argv 是否只包含帮助或版本查询
 */
function isHelpOrVersion(args: string[]) {
  return args.length > 0 && args.every(arg => HELP_VERSION_ARGS.has(arg))
}

/**
 * 判断 argv 是否包含指定 option 或等号形式
 */
function hasOption(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => arg === option || arg.startsWith(`${option}=`)))
}

/**
 * 返回不包含等号值的 option 名，避免审批原因携带敏感值
 */
function optionName(arg: string) {
  const equalsIndex = arg.indexOf('=')

  return equalsIndex < 0 ? arg : arg.slice(0, equalsIndex)
}

/**
 * 创建本地修改评估
 */
function mutation(reason: string): ShellCommandAssessment {
  return { category: 'mutation', reason }
}

/**
 * 创建外部影响评估
 */
function external(reason: string): ShellCommandAssessment {
  return { category: 'externalEffect', reason }
}

/**
 * 创建未知评估
 */
function unknown(reason: string): ShellCommandAssessment {
  return { category: 'unknown', reason }
}
