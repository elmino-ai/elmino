import type { ShellCommandAssessment, ShellCommandCategory, ShellCommandPolicy, ShellReviewContext } from './types'

/** -------------------- 常量 -------------------- */
/** 常见帮助和版本查询参数 */
const HELP_VERSION_ARGS = new Set([
  '-?',
  '-V',
  '-h',
  '--help',
  '--help-full',
  '--version',
  'help',
  'version',
])

/** -------------------- 策略注册 -------------------- */
/**
 * 创建代码检索、索引、静态分析与度量工具策略
 */
export function createResearchPolicies(): ShellCommandPolicy[] {
  return [
    {
      id: 'ast-grep',
      executables: ['ast-grep', 'sg'],
      assess: args => assessAstGrep(args),
    },
    {
      id: 'semgrep',
      executables: ['semgrep'],
      assess: (args, context) => assessSemgrep(args, context),
    },
    {
      id: 'universal-ctags',
      executables: ['ctags', 'etags', 'universal-ctags'],
      assess: (args, context) => assessCtags(args, context),
    },
    {
      id: 'cscope',
      executables: ['cscope'],
      assess: (args, context) => assessCscope(args, context),
    },
    {
      id: 'gnu-global-query',
      executables: ['global'],
      assess: args => assessGlobal(args),
    },
    {
      id: 'gnu-global-index',
      executables: ['gtags', 'htags'],
      assess: (args, context) => assessIndexer(args, context, ['-o', '--output']),
    },
    {
      id: 'scip-lsif-indexers',
      executables: [
        'lsif-go',
        'lsif-java',
        'lsif-tsc',
        'scip',
        'scip-clang',
        'scip-java',
        'scip-python',
        'scip-typescript',
      ],
      assess: (args, context) => assessScip(args, context),
    },
    {
      id: 'tree-sitter',
      executables: ['tree-sitter'],
      assess: (args, context) => assessTreeSitter(args, context),
    },
    {
      id: 'repomix',
      executables: ['repomix'],
      assess: (args, context) => assessRepomix(args, context),
    },
    {
      id: 'madge',
      executables: ['madge'],
      assess: (args, context) => assessWorkspaceReport(
        args,
        context,
        ['--image', '--output'],
      ),
    },
    {
      id: 'dependency-cruiser',
      executables: ['depcruise', 'depcruise-fmt', 'dependency-cruiser'],
      assess: (args, context) => assessDependencyCruiser(args, context),
    },
    {
      id: 'knip',
      executables: ['knip'],
      assess: args => assessKnip(args),
    },
    {
      id: 'code-metrics',
      executables: ['cloc', 'scc', 'tokei'],
      assess: (args, context) => assessMetrics(args, context),
    },
  ]
}

/** -------------------- 内部函数 -------------------- */
/**
 * 评估 ast-grep 的查询、扫描和规则测试入口
 */
function assessAstGrep(args: string[]): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['-i', '-U', '--interactive', '--rewrite', '--update-all']))
    return mutation('ast-grep 参数会重写源码或更新测试快照')

  const subcommand = readKnownSubcommand(args, [
    'completions',
    'lsp',
    'new',
    'run',
    'scan',
    'test',
  ])

  if (subcommand === 'new' || subcommand === 'lsp')
    return mutation(`ast-grep ${subcommand} 会创建项目文件或启动语言服务`)
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'completions')
    return { category: 'query' }
  if (!subcommand || subcommand === 'run' || subcommand === 'scan')
    return { category: 'check' }

  return unknown(`ast-grep ${subcommand} 未在代码调研策略内`)
}

/**
 * 评估 Semgrep 本地扫描并限制修复、服务与远端操作
 */
function assessSemgrep(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['--autofix', '--fix', '--rewrite-rule-ids']))
    return mutation('Semgrep 参数会自动修改扫描目标或规则')

  const subcommand = readKnownSubcommand(args, [
    'ci',
    'install-semgrep-pro',
    'lsp',
    'login',
    'logout',
    'publish',
    'scan',
    'show',
    'validate',
  ])

  if (['ci', 'install-semgrep-pro', 'lsp', 'login', 'logout', 'publish'].includes(subcommand ?? ''))
    return external(`Semgrep ${subcommand} 会访问远端、安装组件或启动语言服务`)

  return assessOutputPaths(
    args,
    context,
    ['-o', '--json-output', '--output', '--sarif-output'],
    subcommand === 'show' ? 'query' : 'check',
  )
}

/**
 * 评估 Ctags 查询和可信根内标签索引生成
 */
function assessCtags(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args) || args.some(arg => arg.startsWith('--list-')))
    return { category: 'query' }
  if (hasOption(args, ['--options']) && !args.includes('--options=NONE'))
    return mutation('Ctags 不允许从未评审的 options 文件加载输出策略')
  if (hasOption(args, ['--filter', '-x']))
    return { category: 'query' }

  const output = readOptionValue(args, ['-f', '-o']) ?? 'tags'

  if (output === '-')
    return { category: 'query' }

  return context.containsPath(output, false)
    ? { category: 'trustedExecution' }
    : mutation(`Ctags 标签输出路径不在可信根内: ${output}`)
}

/**
 * 评估 Cscope 查询和可信根内数据库构建
 */
function assessCscope(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }

  const database = readOptionValue(args, ['-f']) ?? 'cscope.out'

  if (database !== '-' && !context.containsPath(database, false))
    return mutation(`Cscope 数据库路径不在可信根内: ${database}`)
  if (hasOption(args, ['-L', '-d']))
    return { category: 'query' }
  if (hasOption(args, ['-b', '-U', '-u']))
    return { category: 'trustedExecution' }

  return unknown('Cscope 仅允许 -L/-d 查询或 -b/-u 索引构建')
}

/**
 * 评估 GNU Global 查询和索引更新
 */
function assessGlobal(args: string[]): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['-u', '--single-update', '--update']))
    return { category: 'trustedExecution' }
  if (hasOption(args, ['--from-here']) || args.length > 0)
    return { category: 'query' }

  return { category: 'query' }
}

/**
 * 评估仅在可信根产生索引的工具
 */
function assessIndexer(
  args: string[],
  context: ShellReviewContext,
  outputOptions: readonly string[],
): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (args.some(arg => ['daemon', 'publish', 'serve', 'upload'].includes(arg.toLowerCase())))
    return external('索引工具不允许启动服务或上传索引')

  return assessOutputPaths(args, context, outputOptions, 'trustedExecution')
}

/**
 * 评估 SCIP 和 LSIF 查询及索引生成
 */
function assessScip(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (args.some(arg => ['daemon', 'publish', 'serve', 'upload'].includes(arg.toLowerCase())))
    return external('SCIP/LSIF 工具不允许启动服务或上传索引')

  const subcommand = readKnownSubcommand(args, ['print', 'snapshot', 'stats'])
  const category = subcommand === 'print' || subcommand === 'stats'
    ? 'query'
    : 'trustedExecution'

  return assessOutputPaths(
    args,
    context,
    ['-o', '--index-file', '--output', '--output-file'],
    category,
  )
}

/**
 * 评估 tree-sitter 查询、测试与解析器构建
 */
function assessTreeSitter(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }

  const subcommand = readKnownSubcommand(args, [
    'build',
    'completions',
    'dump-languages',
    'generate',
    'highlight',
    'init',
    'init-config',
    'parse',
    'playground',
    'query',
    'tags',
    'test',
  ])

  if (['init', 'init-config', 'playground'].includes(subcommand ?? ''))
    return mutation(`tree-sitter ${subcommand} 会创建配置或启动服务`)
  if (subcommand === 'test')
    return { category: 'test' }
  if (['build', 'generate'].includes(subcommand ?? '')) {
    return assessOutputPaths(
      args,
      context,
      ['-o', '--output'],
      'build',
    )
  }
  if (['completions', 'dump-languages', 'highlight', 'parse', 'query', 'tags'].includes(subcommand ?? ''))
    return { category: 'query' }

  return unknown(`tree-sitter ${subcommand ?? ''} 未在代码调研策略内`)
}

/**
 * 评估 Repomix 本地代码聚合和可信根内报告输出
 */
function assessRepomix(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['--copy', '--init', '--remote', '--watch']))
    return external('Repomix 参数会修改配置、访问远端、剪贴板或启动监听')
  if (args.includes('--stdout'))
    return { category: 'query' }

  return assessOutputPaths(
    args,
    context,
    ['-o', '--output'],
    'trustedExecution',
    'repomix-output.xml',
  )
}

/**
 * 评估依赖图查询和可信根内报告输出
 */
function assessDependencyCruiser(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['--init']))
    return mutation('dependency-cruiser --init 会写入项目配置')

  return assessWorkspaceReport(args, context, ['--output-to'])
}

/**
 * 评估 Knip 静态检查并拒绝自动修复
 */
function assessKnip(args: string[]): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (args.some(arg => arg === '--watch' || arg === '--fix' || arg.startsWith('--fix-')))
    return mutation('Knip 参数会自动修复项目或启动监听')

  return { category: 'check' }
}

/**
 * 评估代码度量查询和可信根内报告输出
 */
function assessMetrics(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }
  if (hasOption(args, ['--extract-with', '--write-lang-def']))
    return mutation('代码度量工具参数会执行外部提取器或写入语言定义')

  return assessOutputPaths(
    args,
    context,
    ['--out', '--output', '--report-file'],
    'query',
  )
}

/**
 * 评估生成报告的查询工具
 */
function assessWorkspaceReport(
  args: string[],
  context: ShellReviewContext,
  outputOptions: readonly string[],
): ShellCommandAssessment {
  if (isHelpOrVersion(args))
    return { category: 'query' }

  return assessOutputPaths(args, context, outputOptions, 'check')
}

/**
 * 校验全部显式或默认输出均位于可信根
 */
function assessOutputPaths(
  args: string[],
  context: ShellReviewContext,
  outputOptions: readonly string[],
  category: ShellCommandCategory,
  defaultOutput?: string,
): ShellCommandAssessment {
  const outputs = readOptionValues(args, outputOptions)

  if (outputs.some(output => !output))
    return unknown('输出参数缺少路径')
  if (defaultOutput && outputs.length === 0)
    outputs.push(defaultOutput)

  const outside = outputs.find(output => output !== '-' && !context.containsPath(output, false))

  return outside
    ? mutation(`输出路径不在可信根内: ${outside}`)
    : { category }
}

/**
 * 判断是否仅请求帮助或版本
 */
function isHelpOrVersion(args: string[]) {
  return args.length > 0 && args.every(arg => (
    HELP_VERSION_ARGS.has(arg) || arg.startsWith('--help=') || arg.startsWith('--version=')
  ))
}

/**
 * 读取参数中出现的已知子命令
 */
function readKnownSubcommand(args: string[], candidates: readonly string[]) {
  return args.find(arg => candidates.includes(arg))
}

/**
 * 判断 argv 是否包含短参数、长参数或等号形式
 */
function hasOption(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => (
    arg === option || arg.startsWith(`${option}=`)
  )))
}

/**
 * 读取首个 option 的值
 */
function readOptionValue(args: string[], options: readonly string[]) {
  return readOptionValues(args, options)[0]
}

/**
 * 收集 option 的空格、等号和短参数紧凑形式值
 */
function readOptionValues(args: string[], options: readonly string[]) {
  const values: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if (options.includes(arg)) {
      values.push(args[index + 1] ?? '')
      index++
      continue
    }

    const equals = options.find(option => arg.startsWith(`${option}=`))

    if (equals) {
      values.push(arg.slice(equals.length + 1))
      continue
    }

    const compact = options.find(option => (
      option.length === 2
      && option.startsWith('-')
      && !option.startsWith('--')
      && arg.startsWith(option)
      && arg.length > option.length
    ))

    if (compact)
      values.push(arg.slice(compact.length))
  }

  return values
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
