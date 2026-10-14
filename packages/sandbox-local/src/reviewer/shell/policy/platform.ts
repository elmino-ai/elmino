import type { ShellCommandAssessment, ShellCommandPolicy, ShellReviewContext } from './types.js'
import { Buffer } from 'node:buffer'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createSubcommandPolicy } from './fixed.js'

/** -------------------- 类型 -------------------- */
/** SQL 客户端的查询参数约定 */
interface SqlClientConfig {
  /** 直接查询参数 */
  queryOptions: readonly string[]
  /** SQL 文件参数 */
  fileOptions: readonly string[]
  /** 是否接受 SQLite 风格的位置参数 */
  positional?: boolean
}

/** -------------------- 常量 -------------------- */
/** 会修改数据库、事务、会话能力或写出文件的 SQL token */
const FORBIDDEN_SQL_TOKENS = new Set([
  'ALTER',
  'ANALYZE',
  'ATTACH',
  'BEGIN',
  'CALL',
  'COMMENT',
  'COMMIT',
  'COPY',
  'CREATE',
  'DELETE',
  'DETACH',
  'DROP',
  'EXEC',
  'EXECUTE',
  'EXPORT',
  'GRANT',
  'IMPORT',
  'INSERT',
  'INSTALL',
  'INTO',
  'LOAD',
  'MERGE',
  'PRAGMA_OPTIMIZE',
  'REINDEX',
  'RELEASE',
  'REPLACE',
  'RESET',
  'REVOKE',
  'ROLLBACK',
  'SAVEPOINT',
  'SET',
  'TRUNCATE',
  'UNLOAD',
  'UPDATE',
  'UPSERT',
  'USE',
  'VACUUM',
])

/** 允许无赋值读取的 SQLite/DuckDB PRAGMA */
const READONLY_PRAGMAS = new Set([
  'APPLICATION_ID',
  'COLLATION_LIST',
  'COMPILE_OPTIONS',
  'DATABASE_LIST',
  'ENCODING',
  'FOREIGN_KEY_LIST',
  'FREELIST_COUNT',
  'FUNCTION_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INTEGRITY_CHECK',
  'MODULE_LIST',
  'PAGE_COUNT',
  'PAGE_SIZE',
  'QUICK_CHECK',
  'SCHEMA_VERSION',
  'TABLE_INFO',
  'TABLE_LIST',
  'TABLE_XINFO',
  'USER_VERSION',
])

/** 允许的只读 SQL 首 token */
const READONLY_SQL_START = new Set(['DESC', 'DESCRIBE', 'EXPLAIN', 'PRAGMA', 'SELECT', 'SHOW', 'WITH'])

/** SQL 中不能进入受限查询面的函数或特殊能力 */
const FORBIDDEN_SQL_CAPABILITIES = [
  'DBMS_',
  'LOAD_EXTENSION',
  'PG_ADVISORY_',
  'PG_CANCEL_BACKEND',
  'PG_LOGICAL_',
  'PG_READ_BINARY_FILE',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_TERMINATE_BACKEND',
  'PG_WRITE_FILE',
  'READFILE',
  'SQLITE_WRITEFILE',
  'SYSTEM$',
] as const

/** 允许的 psql 只读元命令 */
const READONLY_PSQL_META = /^(?:\\conninfo|\\d[A-Za-z+]*|\\encoding|\\l\+?|\\pset|\\timing|\\x)(?:\s|$)/

/** 允许的 SQLite/DuckDB 只读点命令 */
const READONLY_DOT_META = /^\.(?:databases|dbconfig|indexes|schema|show|tables)(?:\s|$)/i

/** 云 CLI 的显式只读 operation 表 */
const AWS_READONLY_OPERATIONS = new Set([
  'cloudformation:describe-stacks',
  'cloudformation:list-stacks',
  'ec2:describe-images',
  'ec2:describe-instances',
  'ec2:describe-regions',
  'ec2:describe-security-groups',
  'ec2:describe-subnets',
  'ec2:describe-vpcs',
  'eks:describe-cluster',
  'eks:list-clusters',
  'iam:get-account-summary',
  'iam:list-account-aliases',
  'lambda:get-function-configuration',
  'lambda:list-functions',
  'rds:describe-db-clusters',
  'rds:describe-db-instances',
  's3api:get-bucket-location',
  's3api:head-bucket',
  's3api:head-object',
  's3api:list-buckets',
  's3api:list-objects-v2',
  'sts:get-caller-identity',
])

/** Azure CLI 的显式只读命令路径 */
const AZURE_READONLY_OPERATIONS = new Set([
  'account list',
  'account show',
  'aks list',
  'aks show',
  'group list',
  'group show',
  'resource list',
  'resource show',
  'vm list',
  'vm show',
])

/** gcloud 的显式只读命令路径 */
const GCLOUD_READONLY_OPERATIONS = new Set([
  'compute instances describe',
  'compute instances list',
  'config configurations describe',
  'config configurations list',
  'container clusters describe',
  'container clusters list',
  'projects describe',
  'projects list',
])

/** -------------------- 策略注册 -------------------- */
/**
 * 创建 SQL、数据工程、配置、IDL 与平台调研策略
 */
export function createPlatformPolicies(): ShellCommandPolicy[] {
  return [
    createSqlClientPolicy('sqlite-duckdb', ['duckdb', 'sqlite3'], {
      queryOptions: ['-c', '--command'],
      fileOptions: ['-f', '--file'],
      positional: true,
    }),
    createSqlClientPolicy('postgresql', ['pgcli', 'psql'], {
      queryOptions: ['-c', '--command'],
      fileOptions: ['-f', '--file'],
    }),
    createSqlClientPolicy('mysql-mariadb', ['mariadb', 'mycli', 'mysql'], {
      queryOptions: ['-e', '--execute'],
      fileOptions: [],
    }),
    createSqlClientPolicy('sql-server', ['sqlcmd'], {
      queryOptions: ['-Q', '-q'],
      fileOptions: ['-i'],
    }),
    createSqlClientPolicy('oracle-sql', ['sql', 'sqlcl', 'sqlplus'], {
      queryOptions: ['-e', '--execute'],
      fileOptions: ['-f', '--file'],
    }),
    createSqlClientPolicy('clickhouse', ['clickhouse-client'], {
      queryOptions: ['-q', '--query'],
      fileOptions: ['--queries-file'],
    }),
    createSqlClientPolicy('trino-presto', ['presto', 'trino'], {
      queryOptions: ['--execute'],
      fileOptions: ['--file'],
    }),
    createSqlClientPolicy('snowflake', ['snowsql'], {
      queryOptions: ['-q', '--query'],
      fileOptions: ['-f', '--filename'],
    }),
    createSqlClientPolicy('cassandra', ['cqlsh'], {
      queryOptions: ['-e', '--execute'],
      fileOptions: ['-f', '--file'],
    }),
    {
      id: 'bigquery-sql',
      executables: ['bq'],
      assess: (args, context) => assessBigQuery(args, context),
    },
    {
      id: 'databricks-sql',
      executables: ['databricks'],
      assess: (args, context) => assessDatabricks(args, context),
    },
    ...createSchemaPolicies(),
    ...createDataEngineeringPolicies(),
    ...createConfigAndIdlPolicies(),
    ...createInfrastructurePolicies(),
  ]
}

/** -------------------- SQL 评估 -------------------- */
/**
 * 创建共享 token scanner 的 SQL 客户端策略
 */
function createSqlClientPolicy(
  id: string,
  executables: ShellCommandPolicy['executables'],
  config: SqlClientConfig,
): ShellCommandPolicy {
  return {
    id,
    executables,
    assess: (args, context) => assessSqlClient(args, context, config),
  }
}

/**
 * 评估 SQL 客户端的单条查询或工作区 SQL 文件
 */
function assessSqlClient(
  args: string[],
  context: ShellReviewContext,
  config: SqlClientConfig,
): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const filePath = readOption(args, config.fileOptions)

  if (filePath)
    return assessSqlFile(filePath, context)

  const optionQuery = readOption(args, config.queryOptions)
  const positionalQuery = config.positional ? findPositionalSql(args) : undefined
  const sql = optionQuery ?? positionalQuery

  return sql
    ? assessSql(sql)
    : unknown('SQL 客户端缺少可验证的单条只读查询或工作区 SQL 文件')
}

/**
 * 使用 token scanner 评估单条 SQL
 */
export function assessSql(sql: string): ShellCommandAssessment {
  const source = sql.trim()

  if (!source)
    return unknown('SQL 查询为空')
  if (READONLY_PSQL_META.test(source) || READONLY_DOT_META.test(source))
    return { category: 'query' }
  if (source.startsWith('\\') || source.startsWith('.'))
    return dangerous('SQL 客户端元命令可能包含文件、Shell 或输出控制能力')

  const scan = scanSql(source)

  if ('reason' in scan)
    return dangerous(scan.reason)

  const { tokens } = scan
  const first = tokens[0]

  if (!first || !READONLY_SQL_START.has(first))
    return mutation('SQL 仅允许 SELECT/WITH/EXPLAIN/SHOW/DESCRIBE/PRAGMA 查询')
  if (tokens.some(token => FORBIDDEN_SQL_TOKENS.has(token)))
    return mutation('SQL token scanner 检测到写入、事务、过程调用或文件操作')
  if (tokens.some(token => FORBIDDEN_SQL_CAPABILITIES.some(capability => token.startsWith(capability))))
    return dangerous('SQL 查询包含扩展加载、服务端文件或进程控制能力')
  if (first === 'PRAGMA') {
    const pragma = tokens[1]

    if (!pragma || !READONLY_PRAGMAS.has(pragma) || source.includes('='))
      return mutation('PRAGMA 不在固定只读查询表内或包含赋值')
  }

  return { category: 'query' }
}

/**
 * 读取可信根内 SQL 文件并复用单语句 scanner
 */
function assessSqlFile(filePath: string, context: ShellReviewContext): ShellCommandAssessment {
  if (!context.containsPath(filePath) || path.extname(filePath).toLowerCase() !== '.sql')
    return dangerous('SQL 文件必须位于可信根内并使用 .sql 扩展名')

  const resolved = path.resolve(context.cwd, filePath)

  try {
    if (!lstatSync(resolved).isFile())
      return dangerous('SQL 文件不是可信根内的普通文件')

    const sql = readFileSync(resolved, 'utf8')

    if (Buffer.byteLength(sql) > 1_048_576)
      return dangerous('SQL 文件超过受限 scanner 的 1 MiB 上限')

    return assessSql(sql)
  }
  catch {
    return dangerous('SQL 文件无法安全读取')
  }
}

/**
 * 扫描 SQL 字符串并忽略字符串字面量中的内容
 */
function scanSql(source: string): { tokens: string[] } | { reason: string } {
  const tokens: string[] = []
  let token = ''
  let quote: '\'' | '"' | '`' | undefined
  let semicolons = 0

  const pushToken = () => {
    if (token) {
      tokens.push(token.toUpperCase())
      token = ''
    }
  }

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index++
        }
        else {
          quote = undefined
        }
      }

      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      pushToken()
      quote = char
      continue
    }
    if ((char === '-' && next === '-') || (char === '/' && next === '*') || char === '#')
      return { reason: 'SQL 查询包含注释，无法确认注释后的语句边界' }
    if (char === ';') {
      pushToken()
      semicolons++

      if (source.slice(index + 1).trim())
        return { reason: 'SQL 查询包含多条语句' }

      continue
    }
    if (/[\w$]/.test(char)) {
      token += char
      continue
    }

    pushToken()
  }

  pushToken()

  if (quote)
    return { reason: 'SQL 查询包含未闭合字符串或标识符' }
  if (semicolons > 1)
    return { reason: 'SQL 查询包含多条语句' }

  return { tokens }
}

/**
 * 从 SQLite/DuckDB 位置参数中寻找显式 SQL
 */
function findPositionalSql(args: string[]) {
  return args.find((arg) => {
    const first = arg.trim().split(/\s+/, 1)[0]?.toUpperCase()
    return first ? READONLY_SQL_START.has(first) || arg.startsWith('\\') || arg.startsWith('.') : false
  })
}

/**
 * 评估 BigQuery 查询命令
 */
function assessBigQuery(args: string[], _context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelp(args) || args[0] === 'ls' || args[0] === 'show')
    return { category: 'query' }
  if (args[0] !== 'query')
    return mutation('bq 当前仅允许 ls/show 和显式只读 query')

  const sql = args.find((arg, index) => index > 0 && !arg.startsWith('-'))
  return sql ? assessSql(sql) : unknown('bq query 缺少 SQL')
}

/**
 * 评估 Databricks 元数据和 SQL 查询
 */
function assessDatabricks(args: string[], _context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = args.filter(arg => !arg.startsWith('-'))

  if (group === 'sql' && operation === 'query') {
    const sql = readOption(args, ['--query'])
    return sql ? assessSql(sql) : unknown('databricks sql query 缺少 --query')
  }
  if (group === 'warehouses' && ['get', 'list'].includes(operation ?? ''))
    return { category: 'query' }

  return mutation('Databricks 当前仅允许 SQL 只读查询和 warehouse 元数据')
}

/** -------------------- Schema 与数据工程 -------------------- */
/**
 * 创建 SQL 检查、Schema diff 与迁移状态查询策略
 */
function createSchemaPolicies(): ShellCommandPolicy[] {
  return [
    createSubcommandPolicy('sql-linters', ['sqlfluff', 'sqruff'], {
      query: ['config', 'dialects', 'help', 'rules', 'version'],
      check: ['lint', 'parse'],
      checkedFormat: ['format'],
      mutation: ['fix'],
    }),
    {
      id: 'pg-formatter',
      executables: ['pg_format', 'pgformatter'],
      assess: args => isVersionOrHelp(args) || hasAny(args, ['--check'])
        ? { category: args.includes('--check') ? 'check' : 'query' }
        : mutation('pgFormatter 必须使用 --check，避免格式写回'),
    },
    {
      id: 'prisma',
      executables: ['prisma'],
      assess: args => assessPrisma(args),
    },
    createSubcommandPolicy('drizzle-kit', ['drizzle-kit'], {
      query: ['check', 'status'],
      check: ['check'],
      mutation: ['drop', 'generate', 'introspect', 'migrate', 'push', 'studio', 'up'],
    }),
    createSubcommandPolicy('alembic', ['alembic'], {
      query: ['branches', 'current', 'heads', 'history', 'show'],
      check: ['check'],
      mutation: ['downgrade', 'edit', 'ensure_version', 'init', 'merge', 'revision', 'stamp', 'upgrade'],
    }),
    createSubcommandPolicy('flyway', ['flyway'], {
      query: ['info'],
      check: ['validate'],
      mutation: ['baseline', 'clean', 'migrate', 'repair', 'undo'],
    }),
    createSubcommandPolicy('liquibase', ['liquibase'], {
      query: ['history', 'status'],
      check: ['diff', 'snapshot', 'validate'],
      trusted: ['changelogSyncSQL', 'rollbackSQL', 'updateSQL'],
      mutation: ['changelogSync', 'clearCheckSums', 'dropAll', 'generateChangeLog', 'rollback', 'tag', 'update'],
    }),
    {
      id: 'atlas',
      executables: ['atlas'],
      assess: args => assessAtlas(args),
    },
  ]
}

/**
 * 评估 Prisma 检查和 Schema diff
 */
function assessPrisma(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const words = positionalWords(args)
  const [group, operation] = words

  if (group === 'validate')
    return { category: 'check' }
  if (group === 'migrate' && operation === 'status')
    return { category: 'query' }
  if (group === 'migrate' && operation === 'diff') {
    return hasAny(args, ['--script'])
      ? { category: 'check' }
      : { category: 'query' }
  }

  return mutation('Prisma 当前仅允许 validate、migrate status/diff，不允许生成或应用变更')
}

/**
 * 评估 Atlas Schema 与迁移查询
 */
function assessAtlas(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = positionalWords(args)

  if (group === 'schema' && ['diff', 'inspect'].includes(operation ?? ''))
    return { category: 'check' }
  if (group === 'migrate' && ['diff', 'hash', 'lint', 'status', 'validate'].includes(operation ?? ''))
    return { category: operation === 'status' ? 'query' : 'check' }

  return mutation('Atlas 当前仅允许 schema inspect/diff 与 migrate status/diff/lint/validate')
}

/**
 * 创建数据工程编译、图查询和本地 dry-run 策略
 */
function createDataEngineeringPolicies(): ShellCommandPolicy[] {
  return [
    {
      id: 'dbt',
      executables: ['dbt'],
      assess: args => assessDbt(args),
    },
    {
      id: 'dvc',
      executables: ['dvc'],
      assess: args => assessDvc(args),
    },
    {
      id: 'snakemake',
      executables: ['snakemake'],
      assess: args => assessSnakemake(args),
    },
    {
      id: 'nextflow',
      executables: ['nextflow'],
      assess: args => assessNextflow(args),
    },
    {
      id: 'airflow',
      executables: ['airflow'],
      assess: args => assessAirflow(args),
    },
    {
      id: 'dagster-prefect-kedro',
      executables: ['dagster', 'kedro', 'prefect'],
      assess: args => assessOrchestrationMetadata(args),
    },
    {
      id: 'spark-flink-beam',
      executables: ['beam', 'flink', 'spark-shell', 'spark-sql', 'spark-submit'],
      assess: args => assessDistributedDataTool(args),
    },
  ]
}

/**
 * 评估 dbt 的解析、编译、图查询和固定 test/build
 */
function assessDbt(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['debug', 'list', 'ls'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (['compile', 'parse'].includes(subcommand ?? ''))
    return { category: 'check' }
  if (subcommand === 'test')
    return { category: 'test' }
  if (subcommand === 'build')
    return { category: 'trustedExecution' }

  return mutation('dbt 当前仅允许 parse/compile/list/debug 与固定 test/build')
}

/**
 * 评估 DVC 状态、图和指标查询
 */
function assessDvc(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = positionalWords(args)

  if (['dag', 'diff', 'doctor', 'list', 'status'].includes(group ?? ''))
    return { category: group === 'doctor' ? 'check' : 'query' }
  if (['metrics', 'params', 'plots'].includes(group ?? '') && ['diff', 'show'].includes(operation ?? ''))
    return { category: 'query' }
  if (group === 'data' && operation === 'status')
    return { category: 'query' }

  return mutation('DVC 当前仅允许 status/list/dag/diff 和显式 metrics/params/plots 查询')
}

/**
 * 评估 Snakemake 列表、检查和受限 dry-run
 */
function assessSnakemake(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }
  if (hasAny(args, ['--lint']))
    return { category: 'check' }
  if (hasAny(args, ['--dag', '--list', '--list-rules', '--rulegraph', '--summary']))
    return { category: 'query' }
  if (hasAny(args, ['-n', '--dry-run'])) {
    return hasAny(args, ['--cluster', '--executor', '--kubernetes', '--profile', '--tibanna'])
      ? dangerous('Snakemake dry-run 包含远程 executor、cluster 或 profile 注入')
      : { category: 'trustedExecution' }
  }

  return mutation('Snakemake 当前仅允许 lint、图查询和无远程 executor 的 dry-run')
}

/**
 * 评估 Nextflow 元数据和预览执行
 */
function assessNextflow(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['config', 'info', 'list', 'log'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'run' && hasAny(args, ['-preview']))
    return { category: 'trustedExecution' }

  return mutation('Nextflow 当前仅允许元数据查询和 run -preview')
}

/**
 * 评估 Airflow DAG 元数据和本地测试
 */
function assessAirflow(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = positionalWords(args)

  if (group === 'dags' && ['details', 'list', 'list-import-errors', 'show'].includes(operation ?? ''))
    return { category: 'query' }
  if (group === 'tasks' && ['list', 'render'].includes(operation ?? ''))
    return { category: 'query' }
  if (['dags', 'tasks'].includes(group ?? '') && operation === 'test')
    return { category: 'test' }

  return mutation('Airflow 当前仅允许 DAG/Task 查询和固定 test，不启动 scheduler/server')
}

/**
 * 评估 Dagster、Prefect 与 Kedro 的显式元数据命令
 */
function assessOrchestrationMetadata(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const words = positionalWords(args).join(' ')
  const allowed = [
    'asset list',
    'catalog list',
    'config view',
    'deployment inspect',
    'deployment ls',
    'deployment list',
    'flow-run inspect',
    'instance info',
    'job list',
    'pipeline list',
    'project info',
  ]

  return allowed.includes(words)
    ? { category: 'query' }
    : mutation('编排工具当前仅允许显式元数据查询，不启动 daemon/server 或执行任意 pipeline')
}

/**
 * 评估 Spark、Flink 与 Beam 的本地查询面
 */
function assessDistributedDataTool(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['info', 'list'].includes(subcommand ?? ''))
    return { category: 'query' }

  return {
    category: 'externalEffect',
    reason: '分布式数据工具的 run/submit/shell 会启动会话或提交远程任务',
  }
}

/** -------------------- 配置与 IDL -------------------- */
/**
 * 创建配置、策略语言和 IDL/schema 工具策略
 */
function createConfigAndIdlPolicies(): ShellCommandPolicy[] {
  return [
    {
      id: 'nix',
      executables: ['nix'],
      assess: args => assessNix(args),
    },
    createSubcommandPolicy('guix', ['guix'], {
      query: ['describe', 'graph', 'search', 'show'],
      build: ['build'],
      mutation: ['environment', 'gc', 'home', 'install', 'package', 'pull', 'remove', 'shell', 'system', 'time-machine'],
    }),
    createSubcommandPolicy('cue', ['cue'], {
      query: ['doc', 'eval'],
      check: ['def', 'vet'],
      checkedFormat: ['fmt'],
      mutation: ['cmd', 'export', 'get', 'import', 'mod'],
    }),
    createSubcommandPolicy('dhall', ['dhall', 'dhall-lint', 'dhall-to-json', 'dhall-to-yaml'], {
      query: ['decode', 'encode', 'lint', 'text', 'type'],
      check: ['lint', 'type'],
      mutation: ['freeze', 'format'],
    }, { allowWithoutSubcommand: 'check' }),
    {
      id: 'jsonnet',
      executables: ['jsonnet'],
      assess: (args, context) => assessJsonnet(args, context),
    },
    createSubcommandPolicy('starlark', ['starlark'], {
      query: ['eval'],
      check: ['check'],
      test: ['test'],
      mutation: ['repl', 'run'],
    }),
    createSubcommandPolicy('opa', ['opa'], {
      query: ['deps', 'eval', 'inspect'],
      check: ['check', 'fmt'],
      test: ['test'],
      trusted: ['build'],
      mutation: ['exec', 'run'],
    }, { checkFlags: { fmt: ['--check'] } }),
    createSubcommandPolicy('hcl', ['hcl2json', 'hclfmt'], {
      query: ['parse'],
      check: ['check'],
      checkedFormat: ['fmt'],
    }, { allowWithoutSubcommand: 'query' }),
    {
      id: 'protoc',
      executables: ['protoc'],
      assess: (args, context) => assessGenerator(args, context, ['--descriptor_set_out']),
    },
    {
      id: 'buf',
      executables: ['buf'],
      assess: (args, context) => assessBuf(args, context),
    },
    {
      id: 'idl-generators',
      executables: ['capnp', 'flatc', 'thrift'],
      assess: (args, context) => assessGenerator(args, context, ['-o', '-out', '--output', '--gen-onefile']),
    },
    createSubcommandPolicy('avro-tools', ['avro-tools'], {
      query: ['cat', 'count', 'fragtojson', 'getschema', 'getmeta', 'tojson'],
      check: ['compile'],
      mutation: ['concat', 'fromjson', 'random'],
    }),
    {
      id: 'graphql-openapi-asyncapi-smithy',
      executables: ['asyncapi', 'graphql-codegen', 'graphql-inspector', 'openapi-generator', 'openapi-generator-cli', 'redocly', 'smithy'],
      assess: (args, context) => assessSchemaTool(args, context),
    },
  ]
}

/**
 * 评估 Nix 的无锁文件写入查询、检查和构建
 */
function assessNix(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }
  if (hasAny(args, ['--impure']))
    return dangerous('Nix --impure 会扩大配置求值的环境和文件读取边界')

  const words = positionalWords(args)
  const [group, operation] = words
  const noLockWrite = args.includes('--no-write-lock-file')

  if (group === 'eval' || (group === 'flake' && ['metadata', 'show'].includes(operation ?? ''))) {
    return noLockWrite
      ? { category: 'query' }
      : mutation('Nix 查询必须使用 --no-write-lock-file')
  }
  if (group === 'flake' && operation === 'check') {
    return noLockWrite
      ? { category: 'check' }
      : mutation('nix flake check 必须使用 --no-write-lock-file')
  }
  if (group === 'build') {
    return noLockWrite && args.includes('--no-link')
      ? { category: 'build' }
      : mutation('nix build 必须使用 --no-write-lock-file --no-link')
  }

  return mutation('Nix 当前仅允许 eval、flake show/metadata/check 和无锁写入 build')
}

/**
 * 评估 Jsonnet stdout 查询或可信根内输出
 */
function assessJsonnet(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }
  if (hasAny(args, ['-e', '-m', '--exec', '--multi']))
    return dangerous('Jsonnet 参数包含执行或多文件写出能力')

  const importPath = readOption(args, ['-J', '--jpath'])

  if (importPath && !context.containsPath(importPath))
    return dangerous('Jsonnet import 搜索路径必须位于可信根内')

  const output = readOption(args, ['-o', '--output-file'])

  return output && !context.containsPath(output, false)
    ? mutation('Jsonnet 输出路径必须位于可信根内')
    : { category: output ? 'trustedExecution' : 'query' }
}

/**
 * 评估 protoc、FlatBuffers、Cap'n Proto 与 Thrift 生成输出
 */
function assessGenerator(
  args: string[],
  context: ShellReviewContext,
  directOutputOptions: readonly string[],
): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }
  if (args.some(arg => arg.startsWith('@')))
    return dangerous('IDL 生成器响应文件会隐藏参数')

  const outputs = collectGeneratorOutputs(args, directOutputOptions)

  if (outputs.some(output => !context.containsPath(output, false)))
    return mutation('IDL 生成输出路径必须位于可信根内')
  if (args.some(arg => arg.startsWith('--plugin=')))
    return { category: 'trustedExecution' }

  return outputs.length > 0 ? { category: 'trustedExecution' } : { category: 'check' }
}

/**
 * 评估 Buf lint、breaking、build 与 generate
 */
function assessBuf(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['breaking', 'lint'].includes(subcommand ?? ''))
    return { category: 'check' }
  if (subcommand === 'build')
    return { category: 'build' }
  if (subcommand === 'generate') {
    const output = readOption(args, ['-o', '--output'])
    return output && !context.containsPath(output, false)
      ? mutation('Buf generate 输出路径必须位于可信根内')
      : { category: 'trustedExecution' }
  }
  if (['config', 'convert', 'curl', 'export', 'mod', 'push', 'registry'].includes(subcommand ?? ''))
    return mutation(`Buf ${subcommand} 可能写出文件、访问 registry 或调用远端`)

  return unknown('Buf 子命令未在 lint/breaking/build/generate 固定策略内')
}

/**
 * 评估 GraphQL、OpenAPI、AsyncAPI 与 Smithy 工具
 */
function assessSchemaTool(args: string[], context: ShellReviewContext): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['breaking', 'check', 'diff', 'lint', 'validate'].includes(subcommand ?? ''))
    return { category: 'check' }
  if (['build', 'compile', 'generate'].includes(subcommand ?? '')) {
    const output = readOption(args, ['-o', '--output', '--output-dir'])
    return output && !context.containsPath(output, false)
      ? mutation('Schema 生成输出路径必须位于可信根内')
      : { category: 'trustedExecution' }
  }

  return mutation('Schema 工具当前仅允许检查、构建和可信根内生成，不允许 registry/publish/serve')
}

/**
 * 收集常见生成器的输出目录或文件参数
 */
function collectGeneratorOutputs(args: string[], directOptions: readonly string[]) {
  const outputs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if (directOptions.includes(arg) && args[index + 1]) {
      outputs.push(args[index + 1]!)
      index++
      continue
    }

    const direct = directOptions.find(option => arg.startsWith(`${option}=`))

    if (direct) {
      outputs.push(arg.slice(direct.length + 1))
      continue
    }

    const generated = arg.match(/^--[\w-]+_out=(.+)$/)

    if (generated)
      outputs.push(generated[1]!)
  }

  return outputs
}

/** -------------------- 平台与基础设施 -------------------- */
/**
 * 创建 CodeGraph、容器、集群、IaC 与云 CLI 查询策略
 */
function createInfrastructurePolicies(): ShellCommandPolicy[] {
  return [
    createSubcommandPolicy('codegraph', ['codegraph'], {
      query: ['affected', 'callees', 'callers', 'explore', 'files', 'help', 'impact', 'node', 'query', 'status', 'version'],
      trusted: ['index', 'sync'],
      mutation: ['daemon', 'init', 'install', 'telemetry', 'uninit', 'uninstall', 'unlock', 'upgrade'],
    }),
    {
      id: 'docker',
      executables: ['docker'],
      assess: args => assessDocker(args),
    },
    {
      id: 'docker-compose',
      executables: ['docker-compose'],
      assess: args => assessDockerCompose(args),
    },
    {
      id: 'kubernetes',
      executables: ['kubectl'],
      assess: args => assessKubectl(args),
    },
    {
      id: 'helm',
      executables: ['helm'],
      assess: args => assessHelm(args),
    },
    {
      id: 'terraform',
      executables: ['terraform', 'tofu'],
      assess: args => assessTerraform(args),
    },
    {
      id: 'pulumi',
      executables: ['pulumi'],
      assess: args => assessPulumi(args),
    },
    {
      id: 'packer',
      executables: ['packer'],
      assess: args => assessPacker(args),
    },
    {
      id: 'vagrant',
      executables: ['vagrant'],
      assess: args => assessVagrant(args),
    },
    {
      id: 'ansible',
      executables: ['ansible', 'ansible-playbook'],
      assess: args => assessAnsible(args),
    },
    createSubcommandPolicy('ansible-query', ['ansible-config', 'ansible-doc', 'ansible-inventory'], {
      query: ['dump', 'graph', 'host', 'list', 'view'],
    }, { allowWithoutSubcommand: 'query' }),
    {
      id: 'cloud-development-kits',
      executables: ['cdk', 'sam', 'serverless'],
      assess: args => assessCloudDevelopmentKit(args),
    },
    {
      id: 'aws-cli',
      executables: ['aws'],
      assess: args => assessAws(args),
    },
    {
      id: 'azure-cli',
      executables: ['az'],
      assess: args => assessAzure(args),
    },
    {
      id: 'gcloud-cli',
      executables: ['gcloud'],
      assess: args => assessGcloud(args),
    },
  ]
}

/**
 * 评估 Docker 本地查询面和 Compose 配置查询
 */
function assessDocker(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const words = positionalWords(args)
  const [group, operation] = words

  if (group === 'compose')
    return assessDockerCompose(args.slice(args.indexOf('compose') + 1))
  if (['images', 'info', 'inspect', 'ps', 'stats', 'top', 'version'].includes(group ?? '')) {
    return group === 'stats' && !hasAny(args, ['--no-stream'])
      ? mutation('docker stats 必须使用 --no-stream，避免持续会话')
      : { category: 'query' }
  }
  if (['container', 'image', 'network', 'volume'].includes(group ?? '')
    && ['inspect', 'list', 'ls'].includes(operation ?? '')) {
    return { category: 'query' }
  }
  if (group === 'logs') {
    return hasAny(args, ['-f', '--follow'])
      ? mutation('docker logs --follow 会建立持续会话')
      : { category: 'query' }
  }

  return mutation('Docker 当前仅允许 inspect/list/logs/config 查询，不允许 build/run/exec 或资源修改')
}

/**
 * 评估 Docker Compose 查询面
 */
function assessDockerCompose(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['config', 'images', 'ls', 'ps', 'top', 'version'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'logs') {
    return hasAny(args, ['-f', '--follow'])
      ? mutation('Docker Compose logs --follow 会建立持续会话')
      : { category: 'query' }
  }

  return mutation('Docker Compose 当前仅允许 config/list/logs 查询')
}

/**
 * 评估 Kubernetes 资源和配置查询
 */
function assessKubectl(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const words = positionalWords(args)
  const [group, operation] = words

  if (['describe', 'get'].includes(group ?? '') && ['secret', 'secrets'].includes(operation?.toLowerCase() ?? ''))
    return dangerous('kubectl 不在自动查询面读取 Secret 资源')
  if (['api-resources', 'api-versions', 'describe', 'explain', 'get', 'version'].includes(group ?? ''))
    return { category: 'query' }
  if (group === 'logs') {
    return hasAny(args, ['-f', '--follow'])
      ? mutation('kubectl logs --follow 会建立持续会话')
      : { category: 'query' }
  }
  if (group === 'config' && ['current-context', 'get-contexts', 'view'].includes(operation ?? '')) {
    return operation === 'view' && hasAny(args, ['--raw'])
      ? dangerous('kubectl config view --raw 可能暴露凭证')
      : { category: 'query' }
  }
  if (group === 'auth' && operation === 'can-i')
    return { category: 'query' }

  return mutation('kubectl 当前仅允许 get/describe/logs/explain/version/config-view 等查询')
}

/**
 * 评估 Helm 查询、模板和 lint
 */
function assessHelm(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group] = positionalWords(args)

  if (['get', 'history', 'list', 'search', 'show', 'status'].includes(group ?? ''))
    return { category: 'query' }
  if (group === 'lint')
    return { category: 'check' }
  if (group === 'template') {
    return hasAny(args, ['--post-renderer'])
      ? dangerous('helm template --post-renderer 会执行外部程序')
      : { category: 'trustedExecution' }
  }

  return mutation('Helm 当前仅允许 list/status/history/get/show/search/template/lint')
}

/**
 * 评估 Terraform/OpenTofu 查询、检查和无输出文件 plan
 */
function assessTerraform(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = positionalWords(args)

  if (group === 'show')
    return { category: 'query' }
  if (group === 'providers') {
    return !operation || operation === 'schema'
      ? { category: 'query' }
      : mutation('terraform providers 当前仅允许列表和 schema 查询')
  }
  if (group === 'state' && ['list', 'show'].includes(operation ?? ''))
    return { category: 'query' }
  if (group === 'validate')
    return { category: 'check' }
  if (group === 'fmt') {
    return hasAny(args, ['-check', '--check'])
      ? { category: 'check' }
      : mutation('terraform fmt 必须使用 -check')
  }
  if (group === 'plan') {
    return hasAny(args, ['-destroy', '--destroy']) || hasOptionPrefix(args, ['-out', '--out'])
      ? mutation('terraform plan 不允许 destroy 或 -out 写出计划文件')
      : { category: 'trustedExecution' }
  }

  return mutation('Terraform/OpenTofu 当前仅允许查询、validate、fmt -check 和无 -out plan')
}

/**
 * 评估 Pulumi 查询、预览和 diff
 */
function assessPulumi(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['about', 'whoami'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (subcommand === 'plugin' && ['ls', 'list'].includes(positionalWords(args)[1] ?? ''))
    return { category: 'query' }
  if (subcommand === 'stack' && ['ls', 'list'].includes(positionalWords(args)[1] ?? ''))
    return { category: 'query' }
  if (subcommand === 'preview') {
    return hasAny(args, ['--save-plan'])
      ? mutation('pulumi preview 不允许 --save-plan 写出计划')
      : { category: 'trustedExecution' }
  }

  return mutation('Pulumi 当前仅允许元数据查询和 preview，不允许 up/destroy/import')
}

/**
 * 评估 Packer inspect/validate/fmt check 和插件列表
 */
function assessPacker(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [group, operation] = positionalWords(args)

  if (group === 'inspect' || (group === 'plugins' && operation === 'installed'))
    return { category: 'query' }
  if (group === 'validate')
    return { category: 'check' }
  if (group === 'fmt') {
    return hasAny(args, ['-check', '--check'])
      ? { category: 'check' }
      : mutation('packer fmt 必须使用 -check')
  }

  return mutation('Packer 当前仅允许 inspect、plugins installed、validate 和 fmt -check')
}

/**
 * 评估 Vagrant 状态与配置验证
 */
function assessVagrant(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (subcommand === 'global-status') {
    return hasAny(args, ['--prune'])
      ? mutation('vagrant global-status --prune 会修改状态缓存')
      : { category: 'query' }
  }
  if (subcommand === 'status')
    return { category: 'query' }
  if (subcommand === 'validate')
    return { category: 'check' }

  return mutation('Vagrant 当前仅允许 status/global-status/validate')
}

/**
 * 评估 Ansible syntax/list/check 模式
 */
function assessAnsible(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }
  if (hasAny(args, ['--syntax-check', '--list-hosts', '--list-tags', '--list-tasks']))
    return { category: 'check' }
  if (hasAny(args, ['--check']) && !hasAny(args, ['--diff']))
    return { category: 'trustedExecution' }

  return mutation('Ansible 当前仅允许 syntax/list/check，且不允许 diff 输出潜在敏感内容')
}

/**
 * 评估 CDK、SAM 与 Serverless 的本地查询和生成
 */
function assessCloudDevelopmentKit(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [subcommand] = positionalWords(args)

  if (['doctor', 'info', 'list', 'print'].includes(subcommand ?? ''))
    return { category: 'query' }
  if (['diff', 'validate'].includes(subcommand ?? ''))
    return { category: 'check' }
  if (['build', 'package', 'synth', 'synthesize'].includes(subcommand ?? ''))
    return { category: 'trustedExecution' }

  return {
    category: 'externalEffect',
    reason: '云开发工具当前不允许 deploy、invoke、local server、login 或资源修改',
  }
}

/**
 * 按显式 service/operation 表评估 AWS CLI
 */
function assessAws(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const [service, operation] = positionalWords(args)
  const key = `${service ?? ''}:${operation ?? ''}`

  return AWS_READONLY_OPERATIONS.has(key)
    ? { category: 'query' }
    : {
        category: 'externalEffect',
        reason: 'AWS CLI operation 不在显式只读表内，或可能读取 secret/修改远端',
      }
}

/**
 * 按显式命令路径表评估 Azure CLI
 */
function assessAzure(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const key = positionalWords(args).slice(0, 2).join(' ')

  return AZURE_READONLY_OPERATIONS.has(key)
    ? { category: 'query' }
    : {
        category: 'externalEffect',
        reason: 'Azure CLI 命令不在显式只读表内，或可能读取 secret/修改远端',
      }
}

/**
 * 按显式命令路径表评估 gcloud CLI
 */
function assessGcloud(args: string[]): ShellCommandAssessment {
  if (isVersionOrHelp(args))
    return { category: 'query' }

  const key = positionalWords(args).slice(0, 3).join(' ')

  return GCLOUD_READONLY_OPERATIONS.has(key)
    ? { category: 'query' }
    : {
        category: 'externalEffect',
        reason: 'gcloud 命令不在显式只读表内，或可能读取凭证/修改远端',
      }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 读取 option 后或等号后的值
 */
function readOption(args: string[], options: readonly string[]) {
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
 * 提取排除 flag 及其常见值后的命令词
 */
function positionalWords(args: string[]) {
  const words: string[] = []
  const optionsWithValue = new Set([
    '--config',
    '--context',
    '--endpoint-url',
    '--namespace',
    '--output',
    '--profile',
    '--project',
    '--region',
    '--stack',
    '--subscription',
    '-C',
    '-c',
    '-n',
    '-o',
  ])

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if (optionsWithValue.has(arg)) {
      index++
      continue
    }
    if (!arg.startsWith('-'))
      words.push(arg)
  }

  return words
}

/**
 * 判断是否为版本或帮助查询
 */
function isVersionOrHelp(args: string[]) {
  return args.length > 0 && args.every(arg => (
    ['-?', '-V', '-h', '--help', '--version', '-help', '-version', 'help', 'version'].includes(arg)
    || arg.startsWith('--help=')
  ))
}

/**
 * 判断 argv 是否包含任一完整 option
 */
function hasAny(args: string[], options: readonly string[]) {
  return args.some(arg => options.includes(arg))
}

/**
 * 判断 argv 是否包含 option 或等号形式
 */
function hasOptionPrefix(args: string[], options: readonly string[]) {
  return args.some(arg => options.some(option => arg === option || arg.startsWith(`${option}=`)))
}

/**
 * 创建危险评估
 */
function dangerous(reason: string): ShellCommandAssessment {
  return { category: 'dangerous', reason }
}

/**
 * 创建修改评估
 */
function mutation(reason: string): ShellCommandAssessment {
  return { category: 'mutation', reason }
}

/**
 * 创建未知评估
 */
function unknown(reason: string): ShellCommandAssessment {
  return { category: 'unknown', reason }
}
