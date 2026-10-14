import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../drizzle/runtime/config/drizzle.js'

/** -------------------- 常量 -------------------- */
/** SQLite 包的开发目录，检查与生成均不连接用户数据库 */
const packageRoot = path.resolve(import.meta.dirname, '..')
/** 显式开发生成命令使用的配置 */
const configPath = 'drizzle/runtime/config/drizzle.ts'
/** 当前包声明的 Drizzle Kit CLI，以 Node 直接执行而不依赖平台 Shell 包装 */
const cliPath = path.join(path.dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs')

/** -------------------- 核心函数 -------------------- */
/**
 * 在独立临时目录验证迁移历史与当前 Schema，不修改发布目录
 */
export async function checkRuntimeMigrations(options: {
  /** 待检查的 Schema 文件，默认使用包内 Schema */
  schemaPath?: string
  /** 待检查的迁移历史，默认使用包内已提交资源 */
  migrationsDir?: string
} = {}) {
  if (typeof config.schema !== 'string' || typeof config.out !== 'string')
    throw new Error('RuntimeStore 迁移配置必须包含 Schema 文件和输出目录')
  const sourceSchema = path.resolve(packageRoot, options.schemaPath ?? config.schema)
  const sourceMigrations = path.resolve(packageRoot, options.migrationsDir ?? config.out)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'elmino-migration-check-'))
  const copiedMigrations = path.join(temporary, 'migrations')
  const temporaryConfig = path.join(temporary, 'drizzle.config.mjs')

  try {
    // 1. 隔离迁移历史与生成输出，Drizzle 的目录初始化也只影响当前临时目录
    await cp(sourceMigrations, copiedMigrations, { recursive: true })
    await writeFile(temporaryConfig, `export default ${JSON.stringify({
      dialect: config.dialect,
      schema: sourceSchema,
      out: copiedMigrations,
    })}\n`)

    // 2. 先检查迁移图，再比较真实 Schema 与最近快照；explain 不落盘生成 SQL
    execFileSync(process.execPath, [cliPath, 'check', '--config', temporaryConfig], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    const output = execFileSync(process.execPath, [
      cliPath,
      'generate',
      '--config',
      temporaryConfig,
      '--explain',
      '--output',
      'json',
    ], { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe' })
    const result: unknown = JSON.parse(output)

    if (
      typeof result !== 'object' || result === null
      || !('status' in result) || result.status !== 'no_changes'
    ) {
      throw new Error('RuntimeStore 存在未生成的 Schema 变更，请执行 pnpm --filter @elmino/store-sqlite db:generate')
    }
  }
  finally {
    // 3. 只清理本次 mkdtemp 创建的叶子目录，不触碰传入的历史或包内迁移资源
    await rm(temporary, { recursive: true, force: true })
  }
}

/**
 * 按显式开发命令检查或生成 RuntimeStore 迁移
 */
async function runStoreMigrations(action: string | undefined) {
  if (action === 'check') {
    await checkRuntimeMigrations()
  }
  else if (action === 'generate') {
    execFileSync(process.execPath, [cliPath, 'generate', '--config', configPath], {
      cwd: packageRoot,
      stdio: 'inherit',
    })
  }
  else {
    throw new Error('迁移命令必须是 check 或 generate')
  }

  console.log(`RuntimeStore migrations ${action} completed`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runStoreMigrations(process.argv[2])
