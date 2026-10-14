import type { ShellCommandAssessment, ShellCommandPolicy, ShellReviewContext } from './types'
import { createAgentCliPolicies } from './agent'
import { createSubcommandPolicy } from './fixed'
import { createPlatformPolicies } from './platform'
import { createResearchPolicies } from './research'
import {
  assessArduino,
  assessCast,
  assessConda,
  assessCondaLock,
  assessEmbeddedBuild,
  assessGodot,
  assessHatch,
  assessInterpreter,
  assessJupyter,
  assessMove,
  assessPlatformIo,
  assessPoetry,
  assessPython,
  assessR,
  assessScientificScript,
  assessStata,
  assessUv,
  assessWorkspaceOutputTool,
  createInterpreterPolicies,
  isTrustedScriptFile,
} from './specialized'

/** -------------------- 常量 -------------------- */
/** 明确修改系统、仓库或进程状态的命令 */
const DANGEROUS_COMMANDS = [
  'add-content',
  'call',
  'chgrp',
  'chmod',
  'chown',
  'copy',
  'copy-item',
  'cp',
  'dd',
  'del',
  'doas',
  'erase',
  'kill',
  'killall',
  'md',
  'mkdir',
  'mkfs',
  'mount',
  'move',
  'move-item',
  'mv',
  'new-item',
  'out-file',
  'pkill',
  'rd',
  'remove-item',
  'ren',
  'rename',
  'rename-item',
  'ri',
  'rm',
  'rmdir',
  'set-content',
  'start',
  'start-process',
  'stop-process',
  'su',
  'sudo',
  'touch',
  'umount',
] as const

/** 无写入入口的跨平台查询命令 */
const SYSTEM_QUERY_COMMANDS = [
  'arch',
  'basename',
  'bat',
  'batcat',
  'cat',
  'cd',
  'chdir',
  'cmp',
  'comm',
  'cut',
  'date',
  'df',
  'dirname',
  'dir',
  'driverquery',
  'du',
  'echo',
  'env',
  'fc',
  'file',
  'findstr',
  'fmt',
  'fold',
  'get-childitem',
  'get-command',
  'get-computerinfo',
  'get-content',
  'get-culture',
  'get-date',
  'get-filehash',
  'get-host',
  'get-item',
  'get-location',
  'get-process',
  'get-service',
  'get-timezone',
  'get-uptime',
  'get-variable',
  'gci',
  'gc',
  'gl',
  'groups',
  'head',
  'hostname',
  'id',
  'ipconfig',
  'join-path',
  'ls',
  'lsof',
  'measure',
  'measure-object',
  'netstat',
  'nl',
  'nproc',
  'od',
  'paste',
  'pathchk',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'resolve-dnsname',
  'resolve-path',
  'rvpa',
  'select',
  'select-object',
  'select-string',
  'set-location',
  'sls',
  'sort-object',
  'ss',
  'stat',
  'strings',
  'sw_vers',
  'systeminfo',
  'system_profiler',
  'tail',
  'tasklist',
  'test',
  'test-path',
  'time',
  'tree',
  'tr',
  'true',
  'type',
  'uname',
  'uniq',
  'uptime',
  'ver',
  'wc',
  'where',
  'whereis',
  'which',
  'who',
  'whoami',
  'write-host',
  'write-output',
] as const

/** 哈希查询命令 */
const HASH_QUERY_COMMANDS = [
  'b2sum',
  'cksum',
  'md5',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
] as const

/** 原生与 HPC 编译器名称 */
const NATIVE_COMPILERS = [
  'as',
  'cc',
  'c++',
  'cl',
  'clang',
  'clang++',
  'cobc',
  'dmd',
  'dpcpp',
  'fpc',
  'g++',
  'gcc',
  'gdc',
  'gfortran',
  'ghc',
  'gnatmake',
  'flang',
  'hipcc',
  'icx',
  'icpx',
  'ifort',
  'ifx',
  'ldc2',
  'ml',
  'ml64',
  'mpicc',
  'mpicxx',
  'mpifort',
  'nasm',
  'nvcc',
  'nvfortran',
  'yasm',
  /^(?:clang|clang\+\+|flang|gcc|g\+\+)-\d+(?:\.\d+)*$/,
] as const

/** 编译器加载插件、wrapper 或不透明参数文件的危险参数 */
const COMPILER_INJECTION_OPTIONS = [
  '-Xclang',
  '-cc1',
  '-fplugin',
  '-load',
  '-specs',
  '-wrapper',
  '--compiler-bindir',
  '--forward-unknown-to-host-compiler',
  '/analyze:plugin',
] as const

/** 固定允许的 package script 名称 */
const PACKAGE_SCRIPT_PATTERN = /^(?:build|check|compile|coverage|format:check|lint|package|test|typecheck|verify)(?::[\w.-]+)*$/

/** Git 查询子命令 */
const GIT_QUERY_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'rev-parse',
  'show',
  'status',
])

/** Git 修改仓库或远端的子命令 */
const GIT_MUTATION_SUBCOMMANDS = new Set([
  'add',
  'apply',
  'bisect',
  'checkout',
  'clean',
  'clone',
  'commit',
  'fetch',
  'gc',
  'init',
  'merge',
  'mv',
  'notes',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
])

/** Git 会执行外部程序或写出文件的参数 */
const GIT_DANGEROUS_OPTIONS = new Set([
  '-c',
  '-p',
  '--config-env',
  '--exec-path',
  '--ext-diff',
  '--open-files-in-pager',
  '--output',
  '--paginate',
  '--textconv',
])

/** -------------------- 策略注册表 -------------------- */
/** 所有 Shell 类型和决策面共享的唯一命令策略表 */
export const SHELL_COMMAND_POLICIES: readonly ShellCommandPolicy[] = [
  {
    id: 'dangerous-system-mutation',
    executables: DANGEROUS_COMMANDS,
    assess: (_args, _context) => ({
      category: 'dangerous',
      reason: '命令会修改文件、进程、权限或系统状态，需要用户确认',
    }),
  },
  {
    id: 'system-query',
    executables: SYSTEM_QUERY_COMMANDS,
    assess: (args, _context) => assessSystemQuery(args),
  },
  {
    id: 'hash-query',
    executables: HASH_QUERY_COMMANDS,
    assess: (_args, _context) => ({ category: 'query' }),
  },
  {
    id: 'certutil-hash',
    executables: ['certutil'],
    assess: args => args[0]?.toLowerCase() === '-hashfile'
      ? { category: 'query' }
      : mutation('certutil 仅允许 -hashfile 查询文件哈希'),
  },
  {
    id: 'command-lookup',
    executables: ['command'],
    assess: args => args[0] === '-v' || args[0] === '-V'
      ? { category: 'query' }
      : mutation('command 仅允许 -v/-V 查询可执行文件'),
  },
  {
    id: 'git',
    executables: ['git'],
    assess: args => assessGit(args),
  },
  {
    id: 'ripgrep',
    executables: ['rg'],
    assess: args => hasOption(args, ['--pre', '--hostname-bin', '--search-zip', '-z'])
      ? mutation('rg 参数会执行外部程序或额外二进制')
      : { category: 'query' },
  },
  {
    id: 'find',
    executables: ['fd', 'fdfind', 'find'],
    assess: args => hasOption(args, [
      '-delete',
      '-exec',
      '-execdir',
      '-fls',
      '-fprint',
      '-fprint0',
      '-fprintf',
      '-ok',
      '-okdir',
      '--exec',
      '--exec-batch',
    ])
      ? mutation('文件查找命令包含删除、写出或执行外部命令的参数')
      : { category: 'query' },
  },
  {
    id: 'text-programs',
    executables: ['awk', 'gawk', 'mawk', 'nawk', 'sed'],
    assess: args => assessTextProgram(args),
  },
  {
    id: 'structured-data-query',
    executables: ['jq', 'yq'],
    assess: args => hasOption(args, ['-i', '--in-place', '--output-format'])
      ? mutation('结构化数据命令包含原地写入或输出格式转换参数')
      : { category: 'query' },
  },
  {
    id: 'diff-query',
    executables: ['diff', 'diff3', 'sdiff'],
    assess: args => hasOption(args, ['-o', '--output'])
      ? mutation('diff 命令包含输出文件参数')
      : { category: 'query' },
  },
  {
    id: 'sort-query',
    executables: ['sort'],
    assess: args => hasOption(args, ['-o', '--output', '--compress-program'])
      ? mutation('sort 命令包含写入文件或执行外部程序的参数')
      : { category: 'query' },
  },
  {
    id: 'xcode-query',
    executables: ['xcodebuild'],
    assess: args => args.some(arg => [
      '-checkFirstLaunchStatus',
      '-list',
      '-showBuildSettings',
      '-showdestinations',
      '-showsdks',
      '-version',
    ].includes(arg))
      ? { category: 'query' }
      : mutation('xcodebuild 当前仅允许版本、SDK、工程与构建设置查询'),
  },
  {
    id: 'xcrun-query',
    executables: ['xcrun'],
    assess: args => args.every(arg => ['--find', '--sdk', '--show-sdk-path', '--show-sdk-platform-path', '--show-sdk-version', '--toolchain', '--version'].includes(arg) || !arg.startsWith('-'))
      && args.some(arg => ['--find', '--show-sdk-path', '--show-sdk-platform-path', '--show-sdk-version', '--version'].includes(arg))
      ? { category: 'query' }
      : mutation('xcrun 当前仅允许工具和 SDK 查询'),
  },
  {
    id: 'native-compilers',
    executables: NATIVE_COMPILERS,
    assess: (args, context) => assessCompiler(args, context),
  },
  {
    id: 'native-static-analysis',
    executables: [
      'clang-format',
      'clang-tidy',
      'cppcheck',
      'include-what-you-use',
      'iwyu',
    ],
    assess: args => hasOption(args, ['-fix', '--fix', '-i', '--in-place'])
      ? mutation('静态检查工具包含自动修复或原地写入参数')
      : { category: 'check' },
  },
  {
    id: 'llvm-query-tools',
    executables: [
      'llvm-ar',
      'llvm-config',
      'llvm-cov',
      'llvm-dis',
      'llvm-dwarfdump',
      'llvm-nm',
      'llvm-objdump',
      'llvm-readelf',
      'llvm-readobj',
      'nm',
      'objdump',
      'otool',
      'readelf',
      'size',
    ],
    assess: args => hasOption(args, ['-o', '--output'])
      ? mutation('二进制检查工具包含输出文件参数')
      : { category: 'query' },
  },
  {
    id: 'cmake',
    executables: ['cmake'],
    assess: args => assessCmake(args),
  },
  {
    id: 'ctest',
    executables: ['ctest'],
    assess: args => hasOption(args, ['--overwrite', '--submit-index'])
      ? mutation('ctest 参数会覆盖或提交测试结果')
      : { category: 'test' },
  },
  {
    id: 'make',
    executables: ['bmake', 'gmake', 'make', 'mingw32-make', 'nmake'],
    assess: args => assessFixedBuildTargets(args, ['all', 'build', 'check', 'compile', 'package', 'test', 'verify']),
  },
  {
    id: 'ninja',
    executables: ['ninja', 'ninja-build'],
    assess: args => assessNinja(args),
  },
  createSubcommandPolicy('meson', ['meson'], {
    query: ['help', 'introspect'],
    check: ['format'],
    test: ['test'],
    build: ['compile', 'setup'],
    mutation: ['devenv', 'install', 'rewrite', 'subprojects', 'wrap'],
  }),
  createSubcommandPolicy('bazel', ['bazel', 'bazelisk'], {
    query: ['aquery', 'cquery', 'help', 'info', 'query', 'version'],
    test: ['coverage', 'test'],
    trusted: ['build'],
    mutation: ['clean', 'fetch', 'run', 'shutdown', 'sync'],
  }),
  createSubcommandPolicy('buck2', ['buck2'], {
    query: ['audit', 'cquery', 'docs', 'help', 'log', 'query', 'status', 'uquery'],
    test: ['test'],
    trusted: ['build'],
    mutation: ['clean', 'install', 'kill', 'run'],
  }),
  createSubcommandPolicy('xmake', ['xmake'], {
    query: ['--help', '--version', 'show'],
    test: ['test'],
    trusted: ['build', 'package'],
    mutation: ['clean', 'create', 'install', 'run', 'uninstall', 'update'],
  }),
  createSubcommandPolicy('premake', ['premake5'], {
    query: ['--help', '--version', 'help'],
    build: ['codelite', 'gmake', 'gmake2', 'vs2019', 'vs2022', 'xcode4'],
    mutation: ['clean'],
  }),
  {
    id: 'autotools',
    executables: ['autoconf', 'autoheader', 'automake', 'autoreconf', 'configure'],
    assess: args => hasOption(args, ['--install', '--force'])
      ? mutation('Autotools 参数会安装辅助文件或强制重写配置')
      : { category: 'build' },
  },
  createSubcommandPolicy('conan', ['conan'], {
    query: ['cache', 'config', 'graph', 'inspect', 'list', 'profile', 'remote', 'search', 'version'],
    build: ['build', 'create'],
    locked: { install: ['--lockfile'] },
    mutation: ['editable', 'export', 'new', 'remove', 'upload'],
  }),
  createSubcommandPolicy('vcpkg', ['vcpkg'], {
    query: ['depend-info', 'find', 'help', 'list', 'search', 'version', 'x-ci-clean'],
    mutation: ['add', 'autocomplete', 'create', 'edit', 'export', 'install', 'integrate', 'remove', 'upgrade', 'x-update-baseline'],
  }),
  createSubcommandPolicy('cargo', ['cargo'], {
    query: ['help', 'metadata', 'tree', 'version'],
    check: ['check', 'clippy', 'fmt'],
    test: ['test'],
    trusted: ['build', 'doc'],
    locked: { fetch: ['--locked'] },
    mutation: ['add', 'clean', 'fix', 'generate-lockfile', 'init', 'install', 'login', 'new', 'publish', 'remove', 'run', 'uninstall', 'update', 'yank'],
  }, {
    checkFlags: { fmt: ['--check'] },
    requireLockedFor: ['build', 'check', 'clippy', 'doc', 'test'],
  }),
  {
    id: 'rustc',
    executables: ['rustc', /^rustc\+.+$/],
    assess: (args, context) => assessCompiler(args, context),
  },
  {
    id: 'rustfmt',
    executables: ['cargo-fmt', 'rustfmt'],
    assess: args => hasOption(args, ['--check'])
      ? { category: 'check' }
      : mutation('Rust 格式化命令必须使用 --check'),
  },
  {
    id: 'go',
    executables: ['go'],
    assess: args => assessGo(args),
  },
  {
    id: 'go-format-check',
    executables: ['gofmt', 'goimports'],
    assess: args => hasOption(args, ['-w'])
      ? mutation('Go 格式化命令包含原地写入参数')
      : { category: 'check' },
  },
  {
    id: 'go-linters',
    executables: ['golangci-lint', 'govulncheck', 'staticcheck'],
    assess: args => hasOption(args, ['--fix'])
      ? mutation('Go 检查工具包含自动修复参数')
      : { category: 'check' },
  },
  createSubcommandPolicy('zig', ['zig'], {
    query: ['env', 'help', 'targets', 'version'],
    check: ['ast-check', 'fmt'],
    test: ['test'],
    build: ['ar', 'build', 'cc', 'c++', 'lib', 'obj'],
    mutation: ['fetch', 'init', 'run'],
  }, { checkFlags: { fmt: ['--check'] } }),
  createSubcommandPolicy('nim', ['nim'], {
    query: ['--help', '--version', 'dump'],
    check: ['check', 'doc'],
    test: ['testament'],
    build: ['c', 'compile', 'cpp', 'js'],
    mutation: ['r', 'run'],
  }),
  createSubcommandPolicy('nimble', ['nimble'], {
    query: ['deps', 'dump', 'help', 'list', 'path', 'search', 'tasks'],
    check: ['check'],
    test: ['test'],
    trusted: ['build'],
    mutation: ['develop', 'init', 'install', 'publish', 'refresh', 'remove', 'run', 'setup', 'sync', 'uninstall'],
  }),
  createSubcommandPolicy('crystal', ['crystal'], {
    query: ['docs', 'env', 'help', 'version'],
    check: ['tool'],
    test: ['spec'],
    build: ['build'],
    mutation: ['eval', 'init', 'play', 'run'],
  }),
  createSubcommandPolicy('shards', ['shards'], {
    query: ['check', 'list', 'prune', 'version'],
    locked: { install: ['--frozen'] },
    mutation: ['build', 'init', 'update'],
  }),
  {
    id: 'native-build-drivers',
    executables: ['chpl', 'gprbuild', 'lazbuild'],
    assess: args => assessBuildDriver(args),
  },
  createSubcommandPolicy('alternative-native', ['dub', 'fpm', 'odin', 'v'], {
    query: ['help', 'list', 'search', 'version'],
    check: ['check', 'doc', 'fmt'],
    test: ['test'],
    build: ['build', 'compile', 'package'],
    mutation: ['add', 'clean', 'init', 'install', 'publish', 'remove', 'run', 'update'],
  }),
  {
    id: 'wasm-tools',
    executables: ['wasm-opt', 'wasm-tools', 'wasm2wat', 'wat2wasm'],
    assess: args => args.some(arg => ['run', 'serve'].includes(arg))
      ? mutation('WebAssembly 工具包含执行或服务入口')
      : { category: isVersionOrHelpQuery(args) ? 'query' : 'build' },
  },
  createSubcommandPolicy('wasm-pack', ['wasm-pack'], {
    query: ['help', 'version'],
    test: ['test'],
    build: ['build'],
    mutation: ['login', 'new', 'pack', 'publish'],
  }),
  createSubcommandPolicy('wasmtime', ['wasmtime'], {
    query: ['config', 'help', 'settings', 'wast'],
    check: ['compile'],
    mutation: ['explore', 'run', 'serve'],
  }),
  {
    id: 'java-runtime-query',
    executables: ['java'],
    assess: (args, context) => assessJava(args, context),
  },
  {
    id: 'jvm-compilers',
    executables: ['groovyc', 'javac', 'javadoc', 'kotlinc', 'scalac', 'vbc'],
    assess: (args, context) => assessCompiler(args, context),
  },
  {
    id: 'maven',
    executables: ['mvn', 'mvnw'],
    assess: args => assessMaven(args),
  },
  {
    id: 'gradle',
    executables: ['gradle', 'gradlew'],
    assess: args => assessGradle(args),
  },
  createSubcommandPolicy('sbt', ['sbt'], {
    query: ['about', 'dependencyTree', 'evicted', 'help', 'projects', 'tasks'],
    test: ['test', 'testOnly'],
    trusted: ['Compile/compile', 'Test/compile', 'compile', 'package'],
    mutation: ['clean', 'console', 'new', 'publish', 'publishLocal', 'run'],
  }),
  createSubcommandPolicy('mill', ['mill'], {
    query: ['inspect', 'path', 'plan', 'resolve', 'show', 'version'],
    test: ['test'],
    trusted: ['compile', 'jar'],
    mutation: ['clean', 'init', 'publish', 'repl', 'run'],
  }),
  createSubcommandPolicy('scala-cli', ['scala-cli'], {
    query: ['about', 'bsp', 'completions', 'config', 'help', 'version'],
    check: ['doc', 'fmt'],
    test: ['test'],
    trusted: ['compile', 'package'],
    mutation: ['clean', 'install-home', 'repl', 'run', 'setup-ide', 'uninstall'],
  }, { checkFlags: { fmt: ['--check'] } }),
  {
    id: 'clojure',
    executables: ['clj', 'clojure'],
    assess: args => assessClojure(args),
  },
  createSubcommandPolicy('leiningen', ['lein'], {
    query: ['classpath', 'deps', 'help', 'pprint', 'version'],
    check: ['check', 'eastwood', 'kibit'],
    test: ['test'],
    trusted: ['compile', 'jar', 'uberjar'],
    mutation: ['clean', 'deploy', 'install', 'new', 'repl', 'run', 'update-in'],
  }),
  {
    id: 'dotnet',
    executables: ['dotnet'],
    assess: args => assessDotnet(args),
  },
  {
    id: 'msbuild',
    executables: ['msbuild'],
    assess: args => assessMsbuild(args),
  },
  {
    id: 'node',
    executables: ['node', /^node\d+(?:\.\d+)*$/],
    assess: (args, context) => assessNode(args, context),
  },
  {
    id: 'npm',
    executables: ['npm'],
    assess: (args, context) => assessJavascriptPackageManager('npm', args, context),
  },
  {
    id: 'pnpm',
    executables: ['pnpm'],
    assess: (args, context) => assessJavascriptPackageManager('pnpm', args, context),
  },
  {
    id: 'yarn',
    executables: ['yarn'],
    assess: (args, context) => assessJavascriptPackageManager('yarn', args, context),
  },
  {
    id: 'bun',
    executables: ['bun'],
    assess: (args, context) => assessJavascriptPackageManager('bun', args, context),
  },
  {
    id: 'typescript-compiler',
    executables: ['tsc'],
    assess: args => hasOption(args, ['--build']) && hasOption(args, ['--clean'])
      ? mutation('tsc --build --clean 会删除构建产物')
      : { category: hasOption(args, ['--noEmit']) ? 'check' : 'build' },
  },
  {
    id: 'javascript-checkers',
    executables: ['biome', 'eslint', 'oxlint', 'prettier', 'stylelint'],
    assess: args => hasOption(args, ['--fix', '--fix-dry-run', '--write'])
      ? mutation('JavaScript 检查工具包含自动修复或写回参数')
      : { category: 'check' },
  },
  {
    id: 'javascript-test-build',
    executables: ['esbuild', 'jest', 'rollup', 'vite', 'vitest', 'webpack'],
    assess: args => assessJavascriptTool(args),
  },
  {
    id: 'deno',
    executables: ['deno'],
    assess: (args, context) => assessDeno(args, context),
  },
  createSubcommandPolicy('elm', ['elm'], {
    query: ['help', 'version'],
    check: ['diff'],
    build: ['make'],
    mutation: ['bump', 'install', 'publish', 'reactor', 'repl'],
  }),
  {
    id: 'elm-test',
    executables: ['elm-test'],
    assess: args => hasOption(args, ['--watch'])
      ? mutation('elm-test --watch 会持续运行')
      : { category: 'test' },
  },
  {
    id: 'purescript-compiler',
    executables: ['purs'],
    assess: (_args, _context) => ({ category: 'build' }),
  },
  createSubcommandPolicy('spago', ['spago'], {
    query: ['docs', 'graph', 'help', 'ls', 'sources', 'version'],
    test: ['test'],
    build: ['bundle', 'build', 'compile'],
    mutation: ['fetch', 'init', 'install', 'publish', 'repl', 'run', 'upgrade'],
  }),
  {
    id: 'rescript-compiler',
    executables: ['bsc'],
    assess: (_args, _context) => ({ category: 'build' }),
  },
  createSubcommandPolicy('rescript', ['rescript'], {
    query: ['help', 'version'],
    check: ['info'],
    build: ['build'],
    mutation: ['clean', 'format'],
  }),
  {
    id: 'haxe-compiler',
    executables: ['haxe'],
    assess: (_args, _context) => ({ category: 'build' }),
  },
  createSubcommandPolicy('haxelib', ['haxelib'], {
    query: ['config', 'help', 'info', 'list', 'path', 'search', 'version'],
    check: ['display'],
    build: ['compile'],
    mutation: ['git', 'install', 'newrepo', 'remove', 'run', 'selfupdate', 'setup', 'submit', 'update'],
  }),
  createSubcommandPolicy('dart', ['dart'], {
    query: ['--help', '--version', 'doc', 'help', 'info'],
    check: ['analyze', 'fix', 'format'],
    test: ['test'],
    build: ['compile'],
    locked: { pub: ['--enforce-lockfile'] },
    mutation: ['create', 'devtools', 'publish', 'run'],
  }, { checkFlags: { fix: ['--dry-run'], format: ['--output=none'] } }),
  createSubcommandPolicy('flutter', ['flutter'], {
    query: ['--version', 'config', 'doctor', 'help'],
    check: ['analyze', 'format'],
    test: ['test'],
    build: ['build'],
    locked: { pub: ['--enforce-lockfile'] },
    mutation: ['attach', 'channel', 'clean', 'create', 'devices', 'drive', 'emulators', 'install', 'precache', 'publish', 'run', 'upgrade'],
  }),
  createSubcommandPolicy('ballerina', ['bal'], {
    query: ['dist', 'graph', 'help', 'version'],
    check: ['doc', 'format'],
    test: ['test'],
    trusted: ['build', 'pack'],
    mutation: ['bindgen', 'clean', 'new', 'publish', 'pull', 'push', 'run', 'semver'],
  }, { checkFlags: { format: ['--dry-run'] } }),
  {
    id: 'python',
    executables: [
      'python',
      'python3',
      'pypy',
      'pypy3',
      /^python\d+(?:\.\d+)*$/,
    ],
    assess: (args, context) => assessPython(args, context),
  },
  createSubcommandPolicy('pip', ['pip', 'pip3', /^pip\d+(?:\.\d+)*$/], {
    query: ['check', 'debug', 'index', 'inspect', 'list', 'show'],
    mutation: ['cache', 'config', 'download', 'freeze', 'hash', 'install', 'uninstall', 'wheel'],
  }),
  {
    id: 'uv',
    executables: ['uv'],
    assess: args => assessUv(args),
  },
  {
    id: 'conda-family',
    executables: ['conda', 'mamba', 'micromamba'],
    assess: (args, context) => assessConda(args, context),
  },
  {
    id: 'conda-lock',
    executables: ['conda-lock'],
    assess: (args, context) => assessCondaLock(args, context),
  },
  {
    id: 'poetry',
    executables: ['poetry'],
    assess: args => assessPoetry(args),
  },
  createSubcommandPolicy('pdm', ['pdm'], {
    query: ['info', 'list', 'show', 'use', 'venv'],
    check: ['check', 'fix'],
    build: ['build'],
    locked: { sync: ['--frozen-lockfile'] },
    mutation: ['add', 'config', 'import', 'init', 'install', 'lock', 'publish', 'remove', 'run', 'update'],
  }, { checkFlags: { fix: ['--dry-run'] } }),
  createSubcommandPolicy('pipenv', ['pipenv'], {
    query: ['check', 'graph', 'requirements'],
    mutation: ['clean', 'install', 'lock', 'open', 'run', 'shell', 'sync', 'uninstall', 'update'],
  }),
  createSubcommandPolicy('pixi', ['pixi'], {
    query: ['info', 'list', 'search', 'tree', 'workspace'],
    check: ['task'],
    locked: { install: ['--frozen'] },
    mutation: ['add', 'clean', 'config', 'exec', 'global', 'init', 'lock', 'remove', 'run', 'self-update', 'shell', 'shell-hook', 'update'],
  }),
  {
    id: 'hatch',
    executables: ['hatch'],
    assess: args => assessHatch(args),
  },
  {
    id: 'python-checkers',
    executables: ['bandit', 'flake8', 'mypy', 'pyright', 'pylint', 'ruff'],
    assess: args => hasOption(args, ['--fix', '--unsafe-fixes'])
      ? mutation('Python 检查工具包含自动修复参数')
      : { category: 'check' },
  },
  {
    id: 'python-format-check',
    executables: ['black', 'isort'],
    assess: args => hasOption(args, ['--check', '--check-only'])
      ? { category: 'check' }
      : mutation('Python 格式化工具必须使用 check 模式'),
  },
  {
    id: 'python-tests',
    executables: ['nox', 'pytest', 'tox'],
    assess: args => hasOption(args, ['--notest', '--devenv'])
      ? mutation('Python 测试工具参数会创建环境但不执行固定测试')
      : { category: 'test' },
  },
  ...createInterpreterPolicies(),
  createSubcommandPolicy('mix', ['mix'], {
    query: ['app.tree', 'deps', 'deps.tree', 'help', 'hex.info'],
    check: ['credo', 'dialyzer', 'format'],
    test: ['test'],
    trusted: ['compile', 'docs'],
    locked: { 'deps.get': ['--check-locked'] },
    mutation: ['archive', 'clean', 'deps.clean', 'deps.update', 'do', 'escript.install', 'hex.publish', 'local', 'new', 'phx.server', 'release', 'run'],
  }, { checkFlags: { format: ['--check-formatted'] } }),
  createSubcommandPolicy('rebar3', ['rebar3'], {
    query: ['as', 'deps', 'help', 'path', 'plugins', 'report', 'tree', 'version'],
    check: ['dialyzer', 'edoc', 'xref'],
    test: ['ct', 'eunit'],
    trusted: ['compile', 'escriptize'],
    mutation: ['clean', 'do', 'new', 'release', 'shell', 'tar', 'upgrade'],
  }),
  createSubcommandPolicy('gleam', ['gleam'], {
    query: ['deps', 'help', 'version'],
    check: ['check', 'format'],
    test: ['test'],
    trusted: ['build', 'docs'],
    mutation: ['add', 'clean', 'dev', 'fix', 'new', 'publish', 'remove', 'run', 'shell', 'update'],
  }, { checkFlags: { format: ['--check'] } }),
  createSubcommandPolicy('haskell-cabal', ['cabal'], {
    query: ['info', 'list', 'path', 'user-config', 'v2-freeze'],
    check: ['check', 'haddock'],
    test: ['test'],
    trusted: ['build'],
    mutation: ['clean', 'configure', 'exec', 'install', 'repl', 'run', 'update', 'upload'],
  }),
  createSubcommandPolicy('haskell-stack', ['stack'], {
    query: ['dot', 'ide', 'ls', 'path', 'query', 'sdist', 'unpack'],
    check: ['haddock'],
    locked: {
      build: ['--lock-file=read-only'],
      test: ['--lock-file=read-only'],
    },
    mutation: ['clean', 'config', 'exec', 'install', 'new', 'repl', 'run', 'setup', 'update', 'upgrade'],
  }),
  createSubcommandPolicy('ocaml-dune', ['dune'], {
    query: ['describe', 'diagnostics', 'help', 'installed-libraries', 'printenv', 'rules'],
    check: ['format-dune-file'],
    test: ['runtest', 'test'],
    trusted: ['build'],
    mutation: ['clean', 'exec', 'install', 'promotion', 'uninstall'],
  }),
  createSubcommandPolicy('opam', ['opam'], {
    query: ['config', 'env', 'info', 'list', 'repository', 'show', 'source', 'switch', 'tree', 'var'],
    mutation: ['admin', 'clean', 'exec', 'init', 'install', 'lock', 'pin', 'reinstall', 'remove', 'update', 'upgrade'],
  }),
  {
    id: 'formal-compilers',
    executables: ['agda', 'coqc', 'dafny', 'fstar.exe', 'idris2', 'lean', 'why3'],
    assess: args => hasOption(args, ['--interactive', '--server'])
      ? mutation('形式化工具包含交互或服务入口')
      : { category: 'check' },
  },
  createSubcommandPolicy('lean-lake', ['lake'], {
    query: ['env', 'help', 'lean', 'print-paths'],
    check: ['check'],
    test: ['test'],
    trusted: ['build'],
    mutation: ['clean', 'env', 'exe', 'init', 'new', 'script', 'serve', 'update', 'upgrade'],
  }),
  createSubcommandPolicy('isabelle', ['isabelle'], {
    query: ['components', 'doc', 'find_facts', 'getenv', 'options', 'version'],
    check: ['build'],
    mutation: ['jedit', 'process', 'server', 'setup', 'update'],
  }),
  {
    id: 'model-checkers',
    executables: ['apalache-mc', 'tlc'],
    assess: args => hasOption(args, ['server', '--server'])
      ? mutation('模型检查器包含服务入口')
      : { category: 'check' },
  },
  {
    id: 'r-language',
    executables: ['R', 'r'],
    assess: (args, context) => assessR(args, context),
  },
  {
    id: 'rscript',
    executables: ['Rscript', 'rscript'],
    assess: (args, context) => assessInterpreter(args, context, ['.r'], ['-e', '--expression', '-'], ['--vanilla', '--no-init-file', '--no-site-file', '--no-environ']),
  },
  {
    id: 'r-checkers',
    executables: ['lintr', 'rcmdcheck', 'styler', 'testthat'],
    assess: args => hasOption(args, ['--style', '--write'])
      ? mutation('R 工具包含自动格式化或写回参数')
      : { category: 'check' },
  },
  {
    id: 'stata',
    executables: ['stata', 'stata-mp', 'stata-se', 'statamp', 'statase'],
    assess: (args, context) => assessStata(args, context),
  },
  {
    id: 'julia',
    executables: ['julia'],
    assess: (args, context) => assessInterpreter(args, context, ['.jl'], ['-e', '-E', '-L', '--eval', '--load', '--startup-file=yes'], ['--startup-file=no', '--project', '--project=@.']),
  },
  {
    id: 'matlab-octave',
    executables: ['matlab', 'octave', 'octave-cli'],
    assess: (args, context) => assessScientificScript(args, context, ['.m']),
  },
  {
    id: 'sas-spss-scilab',
    executables: ['sas', 'scilab', 'scilab-cli', 'stats', 'statisticsb'],
    assess: (args, context) => assessScientificScript(args, context, ['.sas', '.sce', '.sps']),
  },
  {
    id: 'wolfram-q-modeling',
    executables: ['ampl', 'gams', 'q', 'wolframscript'],
    assess: (args, context) => assessScientificScript(args, context, ['.gms', '.mod', '.q', '.wl', '.wls']),
  },
  {
    id: 'jupyter',
    executables: ['jupyter'],
    assess: args => assessJupyter(args),
  },
  {
    id: 'notebook-tools',
    executables: ['jupytext', 'nbclient', 'nbconvert', 'nbqa'],
    assess: (args, context) => assessWorkspaceOutputTool(args, context, ['-o', '--output', '--output-dir']),
  },
  {
    id: 'papermill',
    executables: ['papermill'],
    assess: (args, context) => assessWorkspaceOutputTool(args, context, ['-o', '--output'], 1),
  },
  {
    id: 'report-builders',
    executables: ['asciidoctor', 'latexmk', 'pandoc', 'quarto', 'typst'],
    assess: (args, context) => assessWorkspaceOutputTool(args, context, ['-o', '--output', '--output-dir']),
  },
  {
    id: 'data-query-tools',
    executables: ['csvcut', 'csvgrep', 'csvlook', 'csvstat', 'gdalinfo', 'identify', 'mlr', 'parquet-tools', 'qsv', 'xsv'],
    assess: args => hasOption(args, ['-o', '--output', '--write', '--in-place'])
      ? mutation('数据查询工具包含写出或原地修改参数')
      : { category: 'query' },
  },
  {
    id: 'embedded-platformio',
    executables: ['pio', 'platformio'],
    assess: args => assessPlatformIo(args),
  },
  {
    id: 'arduino',
    executables: ['arduino-cli'],
    assess: args => assessArduino(args),
  },
  {
    id: 'embedded-build',
    executables: ['idf.py', 'west'],
    assess: args => assessEmbeddedBuild(args),
  },
  {
    id: 'hardware-compilers',
    executables: ['ghdl', 'iverilog', 'nvc', 'verilator', 'yosys'],
    assess: (args, context) => assessCompiler(args, context),
  },
  {
    id: 'hardware-checkers',
    executables: ['svlint', 'verible-verilog-format', 'verible-verilog-lint'],
    assess: args => hasOption(args, ['--inplace', '--fix'])
      ? mutation('硬件描述检查工具包含原地修改参数')
      : { category: 'check' },
  },
  {
    id: 'android-adb-query',
    executables: ['adb'],
    assess: args => ['devices', 'get-state', 'get-serialno', 'get-devpath', 'version'].includes(args[0] ?? '')
      || (args[0] === 'shell' && ['dumpsys', 'getprop', 'pm list'].some(prefix => args.slice(1).join(' ').startsWith(prefix)))
      ? { category: 'query' }
      : mutation('ADB 当前仅允许设备状态和明确系统信息查询'),
  },
  {
    id: 'apple-simctl-query',
    executables: ['simctl'],
    assess: args => ['help', 'list', 'listapps'].includes(args[0] ?? '')
      ? { category: 'query' }
      : mutation('simctl 当前仅允许模拟器列表与状态查询'),
  },
  createSubcommandPolicy('expo-capacitor-cordova', ['cap', 'cordova', 'expo'], {
    query: ['config', 'doctor', 'help'],
    check: ['doctor'],
    trusted: ['build', 'export'],
    mutation: ['add', 'create', 'install', 'login', 'open', 'publish', 'remove', 'run', 'serve', 'start'],
  }),
  {
    id: 'godot',
    executables: ['godot', 'godot3', 'godot4'],
    assess: (args, context) => assessGodot(args, context),
  },
  {
    id: 'unity-tests',
    executables: ['Unity', 'unity'],
    assess: args => hasOption(args, ['-runTests'])
      && hasOption(args, ['-batchmode'])
      && !hasOption(args, ['-executeMethod', '-serial', '-username', '-password', '-returnlicense'])
      ? { category: 'test' }
      : mutation('Unity 当前仅允许无凭证的 batch test'),
  },
  {
    id: 'unreal-build-tests',
    executables: ['AutomationTool', 'RunUAT', 'UnrealBuildTool', 'automationtool', 'runuat', 'unrealbuildtool'],
    assess: args => args.some(arg => ['build', 'compile', 'test'].some(word => arg.toLowerCase().includes(word)))
      && !args.some(arg => ['deploy', 'install', 'run', 'server'].some(word => arg.toLowerCase().includes(word)))
      ? { category: 'trustedExecution' }
      : mutation('Unreal 工具当前仅允许本地构建、编译和测试'),
  },
  createSubcommandPolicy('foundry-forge', ['forge'], {
    query: ['config', 'inspect', 'selectors', 'tree', 'verify-check'],
    check: ['fmt'],
    test: ['coverage', 'snapshot', 'test'],
    trusted: ['bind', 'build', 'doc'],
    mutation: ['bind-json', 'clean', 'create', 'flatten', 'init', 'install', 'remove', 'script', 'update', 'verify-contract'],
  }, { checkFlags: { fmt: ['--check'] } }),
  {
    id: 'foundry-cast-query',
    executables: ['cast'],
    assess: args => assessCast(args),
  },
  createSubcommandPolicy('hardhat', ['hardhat'], {
    query: ['help', 'vars'],
    test: ['test'],
    trusted: ['check', 'compile'],
    mutation: ['clean', 'console', 'deploy', 'flatten', 'node', 'run', 'verify'],
  }),
  {
    id: 'solidity-vyper-compilers',
    executables: ['solc', 'vyper'],
    assess: (args, context) => assessCompiler(args, context),
  },
  {
    id: 'move',
    executables: ['aptos', 'sui'],
    assess: args => assessMove(args),
  },
  createSubcommandPolicy('cairo-scarb', ['scarb'], {
    query: ['help', 'manifest-path', 'metadata', 'version'],
    check: ['check', 'fmt'],
    test: ['test'],
    trusted: ['build', 'doc'],
    mutation: ['add', 'clean', 'execute', 'init', 'new', 'publish', 'remove', 'run', 'shell', 'update'],
  }, { checkFlags: { fmt: ['--check'] } }),
  createSubcommandPolicy('starknet-foundry', ['snforge'], {
    query: ['help', 'version'],
    test: ['test'],
    mutation: ['clean'],
  }),
  createSubcommandPolicy('solana-anchor', ['anchor'], {
    query: ['account', 'expand', 'help', 'idl', 'verify', 'version'],
    test: ['test'],
    trusted: ['build'],
    external: ['deploy', 'init', 'keys', 'new', 'publish', 'run', 'upgrade'],
  }),
  ...createAgentCliPolicies(),
  ...createResearchPolicies(),
  ...createPlatformPolicies(),
]

/** -------------------- 内部函数 -------------------- */
/**
 * 判断参数是否命中完整、赋值或短参数组合形式
 */
function hasOption(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => (
    arg === option
    || arg.startsWith(`${option}=`)
    || (option.length === 2 && option.startsWith('-') && !option.startsWith('--') && arg.startsWith(option))
  )))
}

/**
 * 评估通用系统查询参数
 */
function assessSystemQuery(args: string[]): ShellCommandAssessment {
  return hasOption(args, ['-o', '--output', '--output-file', '--log-file'])
    ? mutation('系统查询命令包含输出文件参数')
    : { category: 'query' }
}

/**
 * 评估 Git 查询或修改行为
 */
function assessGit(args: string[]): ShellCommandAssessment {
  let index = 0
  const globalArgs: string[] = []

  while (index < args.length) {
    const arg = args[index]!

    if (['-C', '--git-dir', '--work-tree'].includes(arg)) {
      globalArgs.push(arg, args[index + 1] ?? '')
      index += 2
      continue
    }

    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      globalArgs.push(arg)
      index++
      continue
    }

    if (arg.startsWith('-')) {
      globalArgs.push(arg)
      index++
      continue
    }

    break
  }

  const subcommand = args[index]
  const commandArgs = args.slice(index + 1)

  if (!subcommand)
    return unknown('git 命令缺少可确认的子命令')

  if (hasOption(globalArgs, [...GIT_DANGEROUS_OPTIONS]))
    return mutation('git 全局参数会加载配置、外部程序或 pager')

  if (GIT_MUTATION_SUBCOMMANDS.has(subcommand))
    return mutation(`git ${subcommand} 会修改仓库或远端状态`)

  if (subcommand === 'branch')
    return assessGitListCommand(commandArgs, ['--all', '--contains', '--format', '--list', '--merged', '--no-merged', '--remotes', '-a', '-l', '-r', '-v', '-vv'])

  if (subcommand === 'tag') {
    return commandArgs.length === 0 || hasOption(commandArgs, ['--list', '-l'])
      ? { category: 'query' }
      : mutation('git tag 参数可能创建、修改或删除标签')
  }

  if (subcommand === 'remote') {
    return commandArgs.length === 0 || ['-v', 'get-url', 'show'].includes(commandArgs[0] ?? '')
      ? { category: 'query' }
      : mutation('git remote 子命令会修改远端配置')
  }

  if (subcommand === 'config') {
    return hasOption(commandArgs, ['--get', '--get-all', '--get-regexp', '--list', '--show-origin', '--show-scope'])
      ? { category: 'query' }
      : mutation('git config 当前仅允许显式查询形式')
  }

  if (subcommand === 'worktree')
    return commandArgs[0] === 'list' ? { category: 'query' } : mutation('git worktree 当前仅允许 list')

  if (subcommand === 'submodule')
    return commandArgs[0] === 'status' ? { category: 'query' } : mutation('git submodule 当前仅允许 status')

  if (!GIT_QUERY_SUBCOMMANDS.has(subcommand))
    return unknown(`git ${subcommand} 未在查询策略内`)

  return hasOption(commandArgs, [...GIT_DANGEROUS_OPTIONS])
    ? mutation(`git ${subcommand} 参数会执行外部程序、pager 或写出文件`)
    : { category: 'query' }
}

/**
 * 评估 Git 仅查询列表的子命令参数
 */
function assessGitListCommand(args: string[], allowedOptions: readonly string[]): ShellCommandAssessment {
  if (args.length === 0)
    return { category: 'query' }

  return args.every(arg => !arg.startsWith('-') || allowedOptions.some(option => arg === option || arg.startsWith(`${option}=`)))
    ? { category: 'query' }
    : mutation('git 列表子命令包含修改型参数')
}

/**
 * 评估 awk 与 sed 表达式是否包含写入或执行入口
 */
function assessTextProgram(args: string[]): ShellCommandAssessment {
  if (hasOption(args, ['-i', '--in-place']))
    return mutation('文本处理命令包含原地写入参数')

  const program = args.join(' ')

  const executesCommand = program.includes('system(')
    || program.includes('system (')
    || program.includes('/e')
  const writesFile = program.includes('>')
    || /[;{}\s][ew]\s+\S/.test(program)

  return executesCommand || writesFile
    ? mutation('文本处理表达式包含执行命令或写入文件能力')
    : { category: 'query' }
}

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
 * 评估编译器查询、检查和构建参数
 */
function assessCompiler(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (args.length === 0 || isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (args.some(arg => arg.startsWith('@')))
    return dangerousAssessment('编译器响应文件会隐藏待执行参数')

  if (hasOption(args, COMPILER_INJECTION_OPTIONS))
    return dangerousAssessment('编译器参数会加载插件、wrapper 或外部工具链')

  const output = readOutputPath(args, ['-o', '--output', '/Fe', '/Fo'])

  if (output && !context.containsPath(output, false))
    return mutation(`编译器输出路径不在可信根内: ${output}`)

  return hasOption(args, ['-E', '-fsyntax-only', '--syntax-only', '/Zs'])
    ? { category: 'check' }
    : { category: 'build' }
}

/**
 * 评估 CMake 查询、配置和构建入口
 */
function assessCmake(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || hasOption(args, ['--help-command', '--help-module', '--help-policy', '--help-property', '--system-information']))
    return { category: 'query' }

  if (hasOption(args, ['--install', '-P', '-E']))
    return mutation('CMake install、脚本和任意 -E 命令不在受限构建范围内')

  return { category: 'build' }
}

/**
 * 评估 Make 类工具的固定目标
 */
function assessFixedBuildTargets(args: string[], allowedTargets: readonly string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || hasOption(args, ['-n', '--dry-run', '-p', '--print-data-base', '-q', '--question']))
    return { category: 'query' }

  const targets = args.filter(arg => !arg.startsWith('-') && !arg.includes('='))

  if (targets.some(target => ['clean', 'distclean', 'install', 'uninstall'].includes(target)))
    return mutation('构建目标会清理产物或安装到系统')

  if (targets.length === 0 || targets.every(target => allowedTargets.includes(target)))
    return { category: 'trustedExecution' }

  return unknown(`构建目标 ${targets.join(', ')} 未在固定目标策略内`)
}

/**
 * 评估 Ninja 查询和固定目标
 */
function assessNinja(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || hasOption(args, ['-n', '-t', '--dry-run'])) {
    return args.includes('clean')
      ? mutation('ninja clean 会删除构建产物')
      : { category: 'query' }
  }

  return assessFixedBuildTargets(args, ['all', 'build', 'check', 'compile', 'package', 'test', 'verify'])
}

/**
 * 评估以工程文件为参数的原生构建驱动
 */
function assessBuildDriver(args: string[]): ShellCommandAssessment {
  if (args.length === 0 || isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (args.some(arg => ['clean', 'install', 'publish', 'run', 'uninstall'].includes(arg)))
    return mutation('原生构建驱动包含清理、安装、发布或执行目标')

  return { category: 'build' }
}

/**
 * 评估 Go 命令及其模块子命令
 */
function assessGo(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (['doc', 'env', 'help', 'list', 'version'].includes(subcommand ?? '')) {
    return subcommand === 'env' && hasOption(args, ['-w', '-u'])
      ? mutation('go env -w/-u 会修改持久环境配置')
      : { category: 'query' }
  }

  if (subcommand === 'mod') {
    if (['graph', 'verify', 'why'].includes(nested ?? ''))
      return { category: 'query' }
    if (nested === 'download')
      return { category: 'lockedRestore' }

    return mutation(`go mod ${nested ?? ''} 会修改模块或 vendor 状态`)
  }

  if (subcommand === 'work') {
    return nested === 'edit' && args.includes('-json')
      ? { category: 'query' }
      : mutation('go work 当前仅允许 edit -json 查询')
  }

  if (subcommand === 'vet')
    return { category: 'check' }
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'build')
    return { category: 'build' }
  if (['clean', 'env', 'fix', 'fmt', 'generate', 'get', 'install', 'run'].includes(subcommand ?? ''))
    return mutation(`go ${subcommand} 不在受限开发命令范围内`)

  return unknown(`go ${subcommand ?? ''} 未在固定子命令策略内`)
}

/**
 * 评估 Maven 生命周期和只读插件 goal
 */
function assessMaven(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (args.some(arg => /^-D(?:maven\.ext\.class\.path|java\.system\.class\.loader|plexus)/.test(arg)))
    return dangerousAssessment('Maven 属性会加载扩展或替换类加载器')

  const goals = args.filter(arg => !arg.startsWith('-'))

  if (goals.some(goal => ['clean', 'deploy', 'install', 'release'].some(name => goal === name || goal.startsWith(`${name}:`))))
    return mutation('Maven goal 会清理、安装、发布或修改项目状态')

  if (goals.every(goal => ['validate', 'compile', 'test-compile', 'test', 'package', 'verify'].includes(goal)))
    return { category: 'trustedExecution' }

  if (goals.every(goal => /^(?:dependency:(?:analyze|list|resolve|tree)|help:(?:active-profiles|all-profiles|effective-pom|effective-settings|evaluate|system))$/.test(goal)))
    return { category: 'query' }

  return unknown(`Maven goal ${goals.join(', ')} 未在固定生命周期策略内`)
}

/**
 * 评估 Clojure 内建依赖查询和固定 alias
 */
function assessClojure(args: string[]): ShellCommandAssessment {
  if (args.length === 1 && ['-Sdescribe', '-Spath', '-Stree', '--help', '--version'].includes(args[0]!))
    return { category: 'query' }

  if (args.length === 1 && /^(?:-M|-T|-X):(?:build|test)$/.test(args[0]!))
    return { category: 'trustedExecution' }

  return mutation('Clojure 当前仅允许依赖查询和固定 build/test alias')
}

/**
 * 评估 Java 运行时查询和单文件 source launcher
 */
function assessJava(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (
    args.some(arg => ['--help', '--show-version', '--version', '-help', '-version', '-XshowSettings'].some(option => arg === option || arg.startsWith(`${option}:`)))
    && args.every(arg => arg.startsWith('-'))
  ) {
    return { category: 'query' }
  }

  if (hasOption(args, ['-cp', '-classpath', '--class-path', '-jar', '-m', '--module']))
    return dangerousAssessment('Java 参数会启动 class、JAR 或模块入口')

  const source = args.find(arg => arg.toLowerCase().endsWith('.java'))

  return source && isTrustedScriptFile(source, context, ['.java'])
    ? { category: 'trustedExecution' }
    : mutation('java 当前仅允许查询或可信根内单文件 Java source launcher')
}

/**
 * 评估 Gradle 固定任务及危险全局参数
 */
function assessGradle(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || hasOption(args, ['--dependencies', '--dependencyInsight', '--projects', '--properties', '--tasks']))
    return { category: 'query' }

  if (hasOption(args, ['--continuous', '--include-build', '--init-script', '--write-locks', '-I']))
    return mutation('Gradle 参数会持续运行、加载外部构建或写入依赖锁')

  const tasks = args.filter(arg => !arg.startsWith('-') && !arg.includes('='))

  if (tasks.some(task => /(?:^|:)(?:clean|init|install|publish|release|wrapper)(?:$|:)/i.test(task)))
    return mutation('Gradle task 会清理、初始化、安装或发布项目')

  return tasks.length > 0 && tasks.every(task => /(?:^|:)(?:assemble|build|check|classes|compile\w*|dependencies|dependencyInsight|jar|package|test|testClasses|verify)(?:$|:)/i.test(task))
    ? { category: 'trustedExecution' }
    : unknown(`Gradle task ${tasks.join(', ')} 未在固定任务策略内`)
}

/**
 * 评估 MSBuild 固定 target
 */
function assessMsbuild(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || hasOption(args, ['/version', '-version', '/help', '-help']))
    return { category: 'query' }

  const targetArgs = args.filter(arg => /^(?:-|\/)t(?:arget)?:/i.test(arg))
  const targets = targetArgs.flatMap(arg => (arg.split(':').slice(1).join(':').split(/[;,]/)))

  if (targets.some(target => ['clean', 'pack', 'publish'].includes(target.toLowerCase())))
    return mutation('MSBuild target 会清理或发布项目')

  return targets.length === 0 || targets.every(target => ['build', 'compile', 'restore', 'test'].includes(target.toLowerCase()))
    ? { category: 'trustedExecution' }
    : unknown(`MSBuild target ${targets.join(', ')} 未在固定目标策略内`)
}

/**
 * 评估 dotnet 查询、检查、构建和锁定恢复
 */
function assessDotnet(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args) || args.some(arg => ['--info', '--list-runtimes', '--list-sdks'].includes(arg)))
    return { category: 'query' }

  const [subcommand, nested] = args

  if (subcommand === 'list')
    return ['package', 'reference'].includes(nested ?? '') ? { category: 'query' } : unknown('dotnet list 当前仅允许 package/reference')

  if (subcommand === 'nuget') {
    return ['list', 'locals'].includes(nested ?? '')
      ? { category: 'query' }
      : mutation('dotnet nuget 当前仅允许 list/locals 查询')
  }

  if (subcommand === 'format') {
    return args.includes('--verify-no-changes')
      ? { category: 'check' }
      : mutation('dotnet format 必须使用 --verify-no-changes')
  }

  if (subcommand === 'restore') {
    return args.includes('--locked-mode')
      ? { category: 'lockedRestore' }
      : mutation('dotnet restore 必须使用 --locked-mode')
  }

  if (subcommand === 'msbuild')
    return assessMsbuild(args.slice(1))
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'build')
    return { category: 'trustedExecution' }
  if (['add', 'clean', 'dev-certs', 'new', 'pack', 'publish', 'remove', 'run', 'tool', 'watch', 'workload'].includes(subcommand ?? ''))
    return mutation(`dotnet ${subcommand} 会修改项目、工具链或运行外部程序`)

  return unknown(`dotnet ${subcommand ?? ''} 未在固定子命令策略内`)
}

/**
 * 评估 Node 查询、语法检查和内建测试入口
 */
function assessNode(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (hasOption(args, ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader']))
    return dangerousAssessment('Node 参数包含 eval、输出表达式或预加载入口')

  if (hasOption(args, ['--check']))
    return { category: 'check' }
  if (hasOption(args, ['--test']))
    return { category: 'test' }

  return assessInterpreter(
    args,
    context,
    ['.cjs', '.js', '.mjs'],
    ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader'],
    ['--disable-warning', '--enable-source-maps', '--no-deprecation', '--no-warnings', '--trace-warnings'],
  )
}

/**
 * 评估 Deno 查询、检查、固定 task 与工作区脚本
 */
function assessDeno(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, target] = args

  if (['help', 'info', 'types'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (['check', 'doc', 'lint'].includes(subcommand ?? ''))
    return { category: 'check' }
  if (subcommand === 'fmt')
    return args.includes('--check') ? { category: 'check' } : mutation('deno fmt 必须使用 --check')
  if (['bench', 'test'].includes(subcommand ?? ''))
    return { category: 'test' }
  if (['bundle', 'compile'].includes(subcommand ?? ''))
    return { category: 'build' }
  if (subcommand === 'task') {
    return target && PACKAGE_SCRIPT_PATTERN.test(target)
      ? { category: 'trustedExecution' }
      : unknown(`Deno task ${target ?? ''} 未在固定任务策略内`)
  }
  if (subcommand === 'run') {
    const script = args.find((arg, index) => index > 0 && !arg.startsWith('-'))

    return script && isTrustedScriptFile(script, context, ['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
      ? { category: 'trustedExecution' }
      : dangerousAssessment('deno run 必须使用可信根内明确脚本')
  }
  if (['add', 'eval', 'install', 'jupyter', 'publish', 'repl', 'serve', 'uninstall', 'upgrade'].includes(subcommand ?? ''))
    return mutation(`deno ${subcommand} 会修改工具链、外部状态或启动服务`)

  return unknown(`deno ${subcommand ?? ''} 未在固定子命令策略内`)
}

/**
 * 评估 npm、pnpm、Yarn 与 Bun 的查询、固定任务和锁定恢复
 */
function assessJavascriptPackageManager(
  manager: 'bun' | 'npm' | 'pnpm' | 'yarn',
  args: string[],
  context: ShellReviewContext,
): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  const [subcommand, task] = args
  const queryCommands = ['audit', 'config', 'info', 'list', 'outdated', 'prefix', 'root', 'search', 'view', 'why']
  const mutationCommands = ['add', 'create', 'dev', 'dlx', 'exec', 'init', 'link', 'login', 'logout', 'pack', 'publish', 'rebuild', 'remove', 'serve', 'start', 'unlink', 'unpublish', 'update', 'upgrade', 'version']

  if (manager === 'bun' && subcommand && isTrustedScriptFile(subcommand, context, ['.cjs', '.js', '.mjs', '.mts', '.ts']))
    return { category: 'trustedExecution' }

  if (hasOption(args, ['--watch', '--watchAll', '--continuous', '--serve', '--host']))
    return mutation('package manager 任务包含 watch 或 server 参数')

  if (queryCommands.includes(subcommand ?? '')) {
    if (subcommand === 'audit' && args.includes('fix'))
      return mutation('package manager audit fix 会修改依赖')

    return subcommand === 'config' && !['get', 'list'].includes(task ?? '')
      ? mutation('package manager config 当前仅允许 get/list')
      : { category: 'query' }
  }

  if (mutationCommands.includes(subcommand ?? ''))
    return mutation(`package manager ${subcommand} 会修改依赖、配置、服务或远端状态`)

  if (subcommand === 'ci') {
    return manager === 'npm'
      ? { category: 'lockedRestore' }
      : unknown(`${manager} ci 不是已登记的锁定恢复形式`)
  }

  if (subcommand === 'install') {
    const locked = manager === 'pnpm' || manager === 'bun'
      ? args.includes('--frozen-lockfile')
      : manager === 'yarn' && args.includes('--immutable')

    return locked
      ? { category: 'lockedRestore' }
      : mutation(`${manager} install 缺少对应的 frozen/immutable 锁定参数`)
  }

  if (subcommand === 'fetch') {
    return manager === 'pnpm' && args.includes('--frozen-lockfile')
      ? { category: 'lockedRestore' }
      : mutation('package manager fetch 缺少 --frozen-lockfile')
  }

  if (subcommand === 'run') {
    return task && PACKAGE_SCRIPT_PATTERN.test(task)
      ? { category: 'trustedExecution' }
      : unknown(`package script ${task ?? ''} 未在固定任务策略内`)
  }

  if (subcommand && PACKAGE_SCRIPT_PATTERN.test(subcommand))
    return { category: ['test', 'coverage'].includes(subcommand.split(':')[0]!) ? 'test' : 'trustedExecution' }

  return unknown(`package manager ${subcommand ?? ''} 未在固定子命令策略内`)
}

/**
 * 评估 JavaScript 测试器和 bundler
 */
function assessJavascriptTool(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelpQuery(args))
    return { category: 'query' }

  if (hasOption(args, ['--watch', '--watchAll', '--serve', '--host', '--fix', '--write']))
    return mutation('JavaScript 工具包含 watch、server 或写回参数')

  return { category: 'trustedExecution' }
}

/**
 * 读取常见输出路径参数
 */
function readOutputPath(args: string[], options: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    for (const option of options) {
      if (arg === option)
        return args[index + 1]
      if (arg.startsWith(`${option}=`))
        return arg.slice(option.length + 1)
      if (option.length === 2 && arg.startsWith(option) && arg.length > option.length)
        return arg.slice(option.length)
      if (option.startsWith('/') && arg.toLowerCase().startsWith(option.toLowerCase()) && arg.length > option.length)
        return arg.slice(option.length)
    }
  }
  return undefined
}

/**
 * 创建已知危险能力评估
 */
function dangerousAssessment(reason: string): ShellCommandAssessment {
  return { category: 'dangerous', reason }
}

/**
 * 创建已知修改类评估
 */
function mutation(reason: string): ShellCommandAssessment {
  return { category: 'mutation', reason }
}

/**
 * 创建未知命令评估
 */
function unknown(reason: string): ShellCommandAssessment {
  return { category: 'unknown', reason }
}
