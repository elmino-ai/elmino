import type { ShellCommandAssessment, ShellCommandPolicy, ShellReviewContext } from './types'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** -------------------- 类型 -------------------- */
/** 解释器脚本规则 */
interface InterpreterPolicyConfig {
  /** 策略稳定标识 */
  id: string
  /** 解释器 basename */
  executables: readonly (string | RegExp)[]
  /** 允许的脚本扩展名 */
  extensions: readonly string[]
  /** 解释器级危险参数 */
  dangerous: readonly string[]
  /** 脚本路径前允许的无加载参数 */
  safe?: readonly string[]
}

/** -------------------- 常量 -------------------- */
/** 允许作为受信任工作区脚本直接执行的扩展名 */
const TRUSTED_SCRIPT_EXTENSIONS = new Set([
  '.ado',
  '.bash',
  '.bat',
  '.cjs',
  '.cts',
  '.cl',
  '.clj',
  '.cljc',
  '.cljs',
  '.cmd',
  '.do',
  '.escript',
  '.exs',
  '.fish',
  '.fsx',
  '.gd',
  '.gms',
  '.groovy',
  '.hs',
  '.jl',
  '.js',
  '.jsx',
  '.kts',
  '.lisp',
  '.lua',
  '.luau',
  '.m',
  '.mjs',
  '.ml',
  '.mts',
  '.p6',
  '.php',
  '.pl',
  '.pro',
  '.ps1',
  '.py',
  '.q',
  '.r',
  '.raku',
  '.rb',
  '.rkt',
  '.sas',
  '.sc',
  '.sce',
  '.scm',
  '.sh',
  '.sps',
  '.ss',
  '.tcl',
  '.ts',
  '.tsx',
  '.wls',
  '.wl',
  '.zsh',
])

/** 允许从 shebang 识别的解释器 basename */
const TRUSTED_SHEBANG_INTERPRETERS = new Set([
  'bash',
  'bun',
  'deno',
  'elixir',
  'fish',
  'julia',
  'lua',
  'node',
  'perl',
  'php',
  'python',
  'python3',
  'raku',
  'ruby',
  'sh',
  'tclsh',
  'tsx',
  'zsh',
])

/** 通用解释器脚本策略 */
const INTERPRETER_POLICIES: readonly InterpreterPolicyConfig[] = [
  {
    id: 'ruby',
    executables: ['ruby'],
    extensions: ['.rb'],
    dangerous: ['-e', '-I', '-r', '--disable-gems', '--enable-gems'],
    safe: ['-w', '-W0', '-W1', '-W2'],
  },
  {
    id: 'php',
    executables: ['php'],
    extensions: ['.php'],
    dangerous: ['-B', '-d', '-E', '-F', '-R', '-r', '--define', '--process-begin', '--process-code', '--process-end', '--process-file'],
    safe: ['-n'],
  },
  {
    id: 'perl',
    executables: ['perl'],
    extensions: ['.pl'],
    dangerous: ['-e', '-E', '-I', '-M', '-m'],
    safe: ['-T', '-w'],
  },
  {
    id: 'raku',
    executables: ['raku', 'perl6'],
    extensions: ['.p6', '.raku'],
    dangerous: ['-e', '-I', '-M'],
  },
  {
    id: 'lua',
    executables: ['lua', 'luajit'],
    extensions: ['.lua'],
    dangerous: ['-e', '-i', '-l'],
  },
  {
    id: 'luau',
    executables: ['luau'],
    extensions: ['.lua', '.luau'],
    dangerous: ['-e', '-i'],
  },
  {
    id: 'tcl',
    executables: ['tclsh'],
    extensions: ['.tcl'],
    dangerous: [],
  },
  {
    id: 'posix-shell-script',
    executables: ['bash', 'fish', 'sh', 'zsh'],
    extensions: ['.bash', '.fish', '.sh', '.zsh'],
    dangerous: ['-c', '-s', '--command', '--init-command', '--rcfile'],
    safe: ['--noprofile', '--norc', '-f'],
  },
  {
    id: 'typescript-script',
    executables: ['ts-node', 'tsx'],
    extensions: ['.cts', '.mts', '.ts'],
    dangerous: ['-e', '-i', '-r', '--eval', '--interactive', '--require', '--loader'],
  },
  {
    id: 'jvm-script',
    executables: ['groovy', 'kotlin', 'scala'],
    extensions: ['.groovy', '.kts', '.sc'],
    dangerous: ['-e', '-i', '-I', '-r', '--howtorun', '--loadfiles'],
  },
  {
    id: 'beam-script',
    executables: ['elixir', 'escript'],
    extensions: ['.escript', '.exs'],
    dangerous: ['-e', '-pa', '-pz', '-r', '-S'],
  },
  {
    id: 'haskell-script',
    executables: ['runghc', 'runhaskell'],
    extensions: ['.hs'],
    dangerous: ['-e', '-fplugin', '-pgmF'],
  },
  {
    id: 'ocaml-script',
    executables: ['ocaml'],
    extensions: ['.ml'],
    dangerous: ['-init'],
    safe: ['-noinit', '-noprompt'],
  },
  {
    id: 'fsharp-script',
    executables: ['dotnet-script', 'fsi'],
    extensions: ['.fsx'],
    dangerous: ['--exec', '--load', '--reference', '-r'],
  },
  {
    id: 'lisp-scheme-script',
    executables: ['guile', 'racket', 'scheme'],
    extensions: ['.rkt', '.scm', '.ss'],
    dangerous: ['-c', '-e', '-l', '--command', '--eval', '--load'],
  },
  {
    id: 'prolog-script',
    executables: ['gprolog', 'swipl'],
    extensions: ['.pl', '.pro'],
    dangerous: ['-g', '-t', '--goal', '--toplevel'],
    safe: ['-q', '-s'],
  },
]

/** -------------------- 核心函数 -------------------- */
/**
 * 生成解释型语言的工作区脚本策略
 */
export function createInterpreterPolicies(): ShellCommandPolicy[] {
  const policies: ShellCommandPolicy[] = INTERPRETER_POLICIES.map(config => ({
    id: config.id,
    executables: config.executables,
    assess: (args, context) => assessInterpreter(
      args,
      context,
      config.extensions,
      config.dangerous,
      config.safe,
    ),
  }))

  return [
    ...policies,
    {
      id: 'powershell-script',
      executables: ['powershell', 'pwsh'],
      assess: (args, context) => {
        if (hasOption(args, ['-Command', '-EncodedArguments', '-EncodedCommand']))
          return dangerous('PowerShell 参数包含 command 或编码命令入口')

        return assessFlaggedScript(args, context, ['-File'], [], ['.ps1'])
      },
    },
    {
      id: 'cmd-script',
      executables: ['cmd'],
      assess: (args, context) => {
        const markerIndex = args.findIndex(arg => arg.toLowerCase() === '/c')
        const scriptPath = markerIndex >= 0 ? args[markerIndex + 1] : undefined

        return scriptPath && isTrustedScriptFile(scriptPath, context, ['.bat', '.cmd'])
          ? { category: 'trustedExecution' }
          : dangerous('cmd /c 仅允许可信根内单一 Batch 脚本')
      },
    },
    {
      id: 'common-lisp-script',
      executables: ['sbcl'],
      assess: (args, context) => assessFlaggedScript(args, context, ['--script'], [], ['.cl', '.lisp']),
    },
  ]
}

/**
 * 判断未知 executable 是否是可信根内可直接执行的脚本
 */
export function assessDirectScriptCommand(
  executable: string,
  context: ShellReviewContext,
): ShellCommandAssessment | undefined {
  return isTrustedScriptFile(executable, context)
    ? { category: 'trustedExecution' }
    : undefined
}

/**
 * 评估通用解释器的明确工作区脚本入口
 */
export function assessInterpreter(
  args: string[],
  context: ShellReviewContext,
  extensions: readonly string[],
  dangerousOptions: readonly string[],
  safeOptions: readonly string[] = [],
): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (hasOption(args, dangerousOptions))
    return dangerous('解释器参数包含 eval、REPL、预加载或启动配置入口')

  const scriptIndex = args.findIndex(arg => !arg.startsWith('-'))

  if (scriptIndex < 0)
    return unknown('解释器命令缺少明确工作区脚本文件')

  const prefix = args.slice(0, scriptIndex)

  if (!prefix.every(arg => safeOptions.some(option => arg === option || arg.startsWith(`${option}=`))))
    return unknown('解释器脚本前包含未登记参数')

  const scriptPath = args[scriptIndex]!

  return isTrustedScriptFile(scriptPath, context, extensions)
    ? { category: 'trustedExecution' }
    : dangerous(`脚本文件不在可信根内或扩展名不受支持: ${scriptPath}`)
}

/**
 * 评估 Python 查询、固定模块和明确脚本
 */
export function assessPython(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (hasOption(args, ['-c', '--command', '-i', '-', '-x']))
    return dangerous('Python 参数包含 eval、交互、stdin 或跳过首行入口')

  const moduleIndex = args.findIndex(arg => arg === '-m')

  if (moduleIndex >= 0) {
    const moduleName = args[moduleIndex + 1]
    const moduleArgs = args.slice(moduleIndex + 2)

    if (['pytest', 'unittest'].includes(moduleName ?? ''))
      return { category: 'test' }
    if (['compileall', 'mypy', 'pyright'].includes(moduleName ?? ''))
      return { category: 'check' }
    if (moduleName === 'build')
      return { category: 'build' }
    if (moduleName === 'pip') {
      return ['check', 'debug', 'index', 'inspect', 'list', 'show'].includes(moduleArgs[0] ?? '')
        ? { category: 'query' }
        : mutation('python -m pip 当前仅允许依赖查询')
    }

    return dangerous(`Python 模块 ${moduleName ?? ''} 未在固定模块策略内`)
  }

  return assessInterpreter(
    args,
    context,
    ['.py'],
    ['-c', '-i', '-m', '-x'],
    ['-B', '-E', '-I', '-O', '-OO', '-P', '-S', '-s', '-u'],
  )
}

/**
 * 评估 Conda 系列的查询面
 */
export function assessConda(args: string[], _context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (['info', 'list', 'notices', 'search'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'env' && ['export', 'list'].includes(nested ?? '')) {
    return args.some(arg => ['-f', '--file'].includes(arg))
      ? mutation('conda env export 包含输出文件参数')
      : { category: 'query' }
  }

  return mutation('Conda/Mamba 当前仅允许环境、包和渠道查询；锁定恢复使用 conda-lock')
}

/**
 * 评估 conda-lock 到工作区 prefix 的锁定恢复
 */
export function assessCondaLock(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (args[0] !== 'install')
    return mutation('conda-lock 当前仅允许 install 锁定恢复')

  const prefix = readOptionValue(args, ['-p', '--prefix'])
  const lockFile = args.find(arg => /(?:conda-lock|lock)\.(?:ya?ml|json)$/i.test(arg))

  if (!prefix || !context.containsPath(prefix, false))
    return mutation('conda-lock prefix 必须位于可信根内')
  if (!lockFile || !isTrustedFile(lockFile, context))
    return mutation('conda-lock 必须使用可信根内的明确锁文件')

  return { category: 'lockedRestore' }
}

/**
 * 评估 UV 查询、构建和冻结同步
 */
export function assessUv(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (['help', 'tree', 'version'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'pip') {
    return ['check', 'freeze', 'list', 'show', 'tree'].includes(nested ?? '')
      ? { category: 'query' }
      : mutation('uv pip 当前仅允许依赖查询')
  }
  if (subcommand === 'sync')
    return args.includes('--frozen') ? { category: 'lockedRestore' } : mutation('uv sync 必须使用 --frozen')
  if (subcommand === 'build')
    return { category: 'build' }

  return mutation(`uv ${subcommand ?? ''} 会修改环境、依赖、工具或外部状态`)
}

/**
 * 评估 Poetry 查询、环境信息和构建
 */
export function assessPoetry(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (['about', 'check', 'debug', 'show'].includes(subcommand ?? ''))
    return { category: subcommand === 'check' ? 'check' : 'query' }
  if (subcommand === 'env' && ['info', 'list'].includes(nested ?? ''))
    return { category: 'query' }
  if (subcommand === 'build')
    return { category: 'build' }

  return mutation(`Poetry ${subcommand ?? ''} 会修改环境、依赖、配置或外部状态`)
}

/**
 * 评估 Hatch 环境查询、测试和构建
 */
export function assessHatch(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (['config', 'project', 'status'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'env' && ['find', 'show'].includes(nested ?? ''))
    return { category: 'query' }
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'build')
    return { category: 'trustedExecution' }

  return mutation(`Hatch ${subcommand ?? ''} 会修改环境、项目或外部状态`)
}

/**
 * 评估 R 查询、CMD 构建检查和脚本文件
 */
export function assessR(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (args[0] === 'CMD') {
    if (['build', 'check'].includes(args[1] ?? ''))
      return { category: 'trustedExecution' }

    return mutation(`R CMD ${args[1] ?? ''} 未在固定构建检查策略内`)
  }

  if (hasOption(args, ['-e', '--expression']))
    return dangerous('R 参数包含内联表达式')

  return assessFlaggedScript(args, context, ['-f', '--file'], [], ['.r'])
}

/**
 * 评估使用 marker 指定脚本文件的命令
 */
export function assessFlaggedScript(
  args: string[],
  context: ShellReviewContext,
  markers: readonly string[],
  requiredWords: readonly string[],
  extensions: readonly string[],
): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (requiredWords.length > 0 && !requiredWords.every(word => args.includes(word)))
    return unknown(`脚本命令缺少固定入口 ${requiredWords.join(' ')}`)

  const markerIndex = args.findIndex(arg => markers.includes(arg))
  const scriptPath = markerIndex >= 0
    ? args[markerIndex + 1]
    : args.find(arg => extensions.includes(path.extname(arg).toLowerCase()))

  return scriptPath && isTrustedScriptFile(scriptPath, context, extensions)
    ? { category: 'trustedExecution' }
    : dangerous('脚本命令缺少可信根内的明确脚本文件')
}

/**
 * 评估 Stata batch do-file
 */
export function assessStata(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const doIndex = args.findIndex(arg => arg.toLowerCase() === 'do')
  const scriptPath = doIndex >= 0 ? args[doIndex + 1] : undefined
  const batchMode = args.some(arg => ['-b', '/b'].includes(arg.toLowerCase()))

  return batchMode && scriptPath && isTrustedScriptFile(scriptPath, context, ['.ado', '.do'])
    ? { category: 'trustedExecution' }
    : dangerous('Stata 仅允许 batch 模式执行可信根内明确 do-file')
}

/**
 * 评估科研计算工具的明确脚本入口
 */
export function assessScientificScript(
  args: string[],
  context: ShellReviewContext,
  extensions: readonly string[],
): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (hasOption(args, ['-e', '--eval', '--code', '-r', '--run']))
    return dangerous('科研计算工具包含内联表达式或任意 run 入口')

  const markerPath = readOptionValue(args, ['-batch', '-f', '-file', '--file'])
  const scriptPath = markerPath
    ?? args.find(arg => extensions.includes(path.extname(arg).toLowerCase()))

  return scriptPath && isTrustedScriptFile(scriptPath, context, extensions)
    ? { category: 'trustedExecution' }
    : unknown('科研计算工具缺少可信根内的明确脚本文件')
}

/**
 * 评估 Jupyter 查询、Notebook 执行和服务型入口
 */
export function assessJupyter(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || args.some(arg => ['--data-dir', '--paths', '--runtime-dir'].includes(arg)))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (subcommand === 'kernelspec')
    return nested === 'list' ? { category: 'query' } : mutation('Jupyter kernelspec 当前仅允许 list')
  if (['execute', 'nbconvert', 'run'].includes(subcommand ?? ''))
    return { category: 'trustedExecution' }
  if (['console', 'events', 'kernel', 'lab', 'labextension', 'migrate', 'notebook', 'server', 'serverextension', 'trust'].includes(subcommand ?? ''))
    return mutation(`Jupyter ${subcommand} 会启动服务或修改运行环境`)

  return unknown(`Jupyter ${subcommand ?? ''} 未在固定子命令策略内`)
}

/**
 * 评估生成工作区产物的 Notebook 与报告工具
 */
export function assessWorkspaceOutputTool(
  args: string[],
  context: ShellReviewContext,
  outputOptions: readonly string[],
  positionalOutputIndex?: number,
): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }
  if (hasOption(args, ['--watch', '--serve', '--server', '--inplace'])
    || args.some(arg => ['serve', 'server', 'watch'].includes(arg.toLowerCase()))) {
    return mutation('文档或 Notebook 工具包含服务、监听或原地写入参数')
  }

  const output = readOptionValue(args, outputOptions)
    ?? (positionalOutputIndex === undefined ? undefined : args[positionalOutputIndex])

  return output && !context.containsPath(output, false)
    ? mutation(`输出路径不在可信根内: ${output}`)
    : { category: 'trustedExecution' }
}

/**
 * 评估 PlatformIO 查询、构建与测试
 */
export function assessPlatformIo(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args
  const joined = args.join(' ')

  if (['upload', 'flash', 'monitor', 'erase', 'remote', 'debug'].some(word => joined.toLowerCase().includes(word)))
    return mutation('PlatformIO 参数会写入设备、启动监控或访问远端')
  if (subcommand === 'device' && nested === 'list')
    return { category: 'query' }
  if (['boards', 'home', 'pkg', 'platform'].includes(subcommand ?? '') && ['list', 'search', 'show'].some(word => args.includes(word)))
    return { category: 'query' }
  if (subcommand === 'check')
    return { category: 'check' }
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'run')
    return { category: 'trustedExecution' }

  return unknown(`PlatformIO ${subcommand ?? ''} 未在固定策略内`)
}

/**
 * 评估 Arduino CLI 查询和编译
 */
export function assessArduino(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (subcommand === 'compile')
    return { category: 'build' }
  if (subcommand === 'board' && ['details', 'list', 'listall', 'search'].includes(nested ?? ''))
    return { category: 'query' }
  if (['core', 'lib'].includes(subcommand ?? '') && ['list', 'search'].includes(nested ?? ''))
    return { category: 'query' }

  return mutation('Arduino CLI 当前仅允许板卡/依赖查询和 compile')
}

/**
 * 评估 ESP-IDF 与 Zephyr west 的本地构建
 */
export function assessEmbeddedBuild(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const joined = args.join(' ')

  if (['flash', 'erase', 'monitor', 'debug', 'attach', 'server', 'sign'].some(word => joined.toLowerCase().includes(word)))
    return mutation('嵌入式工具参数会写入设备或启动调试服务')
  if (args.some(arg => ['boards', 'config', 'list', 'manifest', 'packages'].includes(arg)))
    return { category: 'query' }
  if (args.some(arg => ['test', 'twister'].includes(arg)))
    return { category: 'test' }
  if (args.some(arg => ['build', 'compile'].includes(arg)))
    return { category: 'trustedExecution' }

  return unknown('嵌入式构建命令未命中固定查询、测试或构建入口')
}

/**
 * 评估 Godot 检查、测试和工作区 GDScript
 */
export function assessGodot(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }
  if (hasOption(args, ['--editor', '--path', '--project-manager', '--remote-debug', '--server']))
    return mutation('Godot 参数会启动编辑器、服务或切换任意项目')
  if (hasOption(args, ['--check-only']))
    return { category: 'check' }

  const script = readOptionValue(args, ['--script', '-s'])

  return script && isTrustedScriptFile(script, context, ['.gd'])
    ? { category: 'trustedExecution' }
    : unknown('Godot 当前仅允许 check-only 或可信根内 GDScript')
}

/**
 * 评估 Foundry cast 的只读链查询
 */
export function assessCast(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const queryCommands = ['4byte', 'abi-decode', 'age', 'balance', 'block', 'block-number', 'call', 'calldata', 'chain', 'chain-id', 'code', 'codesize', 'compute-address', 'decode-abi', 'estimate', 'gas-price', 'interface', 'logs', 'namehash', 'nonce', 'receipt', 'rpc', 'storage']
  const dangerousCommands = ['access-list', 'mktx', 'publish', 'send', 'sig-event', 'sig-function', 'wallet']
  const subcommand = args[0] ?? ''

  if (dangerousCommands.includes(subcommand) || hasOption(args, ['--private-key', '--keystore', '--mnemonic']))
    return dangerous('cast 参数会签名、发送交易或访问钱包密钥')

  return queryCommands.includes(subcommand)
    ? { category: 'query' }
    : unknown(`cast ${subcommand} 未在只读链查询策略内`)
}

/**
 * 评估 Aptos 与 Sui Move 的本地检查、测试和构建
 */
export function assessMove(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (subcommand === 'move') {
    if (['prove'].includes(nested ?? ''))
      return { category: 'check' }
    if (['test'].includes(nested ?? ''))
      return { category: 'test' }
    if (['build', 'compile'].includes(nested ?? ''))
      return { category: 'trustedExecution' }

    return mutation(`Move 子命令 ${nested ?? ''} 未在本地检查、测试或构建策略内`)
  }

  if (['account', 'client', 'faucet', 'key', 'node', 'object', 'publish', 'transaction', 'upgrade'].includes(subcommand ?? '')) {
    return {
      category: 'externalEffect',
      reason: `${subcommand} 会修改链上、账户或节点状态`,
    }
  }

  return unknown(`Move CLI ${subcommand ?? ''} 未在固定策略内`)
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断路径是否是可信根内允许的脚本文件
 */
export function isTrustedScriptFile(
  filePath: string,
  context: ShellReviewContext,
  extensions?: readonly string[],
): boolean {
  if (!filePath || filePath === '-' || /^[a-z][\w+.-]*:\/\//i.test(filePath))
    return false

  const resolved = path.resolve(context.cwd, filePath)

  if (!context.containsPath(filePath))
    return false

  try {
    if (!lstatSync(resolved).isFile())
      return false

    const extension = path.extname(resolved).toLowerCase()
    const allowedExtensions = extensions
      ? new Set(extensions.map(item => item.toLowerCase()))
      : TRUSTED_SCRIPT_EXTENSIONS

    if (allowedExtensions.has(extension))
      return true

    if (extensions)
      return false

    const firstLine = readFileSync(resolved, 'utf8').slice(0, 512).split(/\r?\n/, 1)[0] ?? ''

    if (!firstLine.startsWith('#!'))
      return false

    const words = firstLine.slice(2).trim().split(/\s+/)
    const interpreter = path.basename(words[0] === '/usr/bin/env' ? words[1] ?? '' : words[0] ?? '')

    return TRUSTED_SHEBANG_INTERPRETERS.has(interpreter)
  }
  catch {
    return false
  }
}

/**
 * 判断命令是否仅请求版本或帮助
 */
function isVersionOrHelpQuery(args: string[]) {
  return args.length > 0 && args.every(arg => (
    ['-?', '-V', '-h', '--help', '--version', '-help', '-version', 'help', 'version'].includes(arg)
    || arg.startsWith('--help=')
  ))
}

/**
 * 判断参数是否包含完整或赋值形式选项
 */
function hasOption(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => (
    arg === option
    || arg.startsWith(`${option}=`)
    || (option.length === 2 && option.startsWith('-') && !option.startsWith('--') && arg.startsWith(option))
  )))
}

/**
 * 读取选项后的路径值
 */
function readOptionValue(args: string[], options: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    for (const option of options) {
      if (arg === option)
        return args[index + 1]
      if (arg.startsWith(`${option}=`))
        return arg.slice(option.length + 1)
    }
  }
  return undefined
}

/**
 * 判断普通文件是否位于可信根内
 */
function isTrustedFile(filePath: string, context: ShellReviewContext) {
  if (!context.containsPath(filePath))
    return false

  try {
    return lstatSync(path.resolve(context.cwd, filePath)).isFile()
  }
  catch {
    return false
  }
}

/**
 * 创建已知修改类评估
 */
function mutation(reason: string): ShellCommandAssessment {
  return { category: 'mutation', reason }
}

/**
 * 创建危险入口评估
 */
function dangerous(reason: string): ShellCommandAssessment {
  return { category: 'dangerous', reason }
}

/**
 * 创建未知入口评估
 */
function unknown(reason: string): ShellCommandAssessment {
  return { category: 'unknown', reason }
}
