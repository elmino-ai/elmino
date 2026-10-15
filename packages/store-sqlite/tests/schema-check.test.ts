import type { Buffer } from 'node:buffer'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { checkRuntimeMigrations } from '../scripts/migrations'

/** -------------------- 常量 -------------------- */
/** 包内提交的真实 RuntimeStore 迁移资源 */
const migrationsDir = path.resolve(import.meta.dirname, '../drizzle/runtime/migrations')
/** 真实 CLI 的冷启动与多次子进程执行采用独立集成预算，保留所有迁移断言 */
const migrationCheckOptions = { timeout: 30_000 }

/** -------------------- 测试 -------------------- */
test('真实 Schema 与既有迁移快照一致，检查前后发布资源保持逐字节一致', migrationCheckOptions, async () => {
  const before = await migrationContents()

  await checkRuntimeMigrations()
  expect(await migrationContents()).toEqual(before)
})

test('新增 Schema 表但未生成迁移时检查失败，漂移分析不写入发布历史', migrationCheckOptions, async () => {
  const before = await migrationContents()
  const temporary = await createCheckFixture()
  const schemaPath = path.join(temporary, 'schema.mjs')
  const source = pathToFileURL(path.resolve(import.meta.dirname, '../src/drizzle/schema/tables.ts')).href
  const sqliteCore = import.meta.resolve('drizzle-orm/sqlite-core')

  await writeFile(schemaPath, `
import { sqliteTable, text } from ${JSON.stringify(sqliteCore)}
export {
  artifacts, canonicalMessages, canonicalParts, steps, threads, threadSpawnEdges,
  toolCalls, transcriptMessages, turns, turnSpawnEdges,
} from ${JSON.stringify(source)}
export const added = sqliteTable('migration_check_added', { id: text('id').primaryKey() })
`)
  await expect(checkRuntimeMigrations({ schemaPath })).rejects.toThrow('存在未生成的 Schema 变更')
  expect(await migrationContents()).toEqual(before)
})

test('损坏的历史快照阻止检查，原有发布 SQL 和快照不会被重建或覆盖', migrationCheckOptions, async () => {
  const before = await migrationContents()
  const temporary = await createCheckFixture()
  const corruptedHistory = path.join(temporary, 'history')

  await cp(migrationsDir, corruptedHistory, { recursive: true })
  await writeFile(path.join(corruptedHistory, '20260909023420_v1/snapshot.json'), '{broken')
  await expect(checkRuntimeMigrations({ migrationsDir: corruptedHistory })).rejects.toThrow()
  expect(await migrationContents()).toEqual(before)
})

/** -------------------- 内部函数 -------------------- */
/**
 * 在迁移历史变更和 Schema 漂移检查前后读取原始资源
 */
async function migrationContents() {
  const directories = await readdir(migrationsDir)
  const contents: Record<string, Buffer> = {}

  for (const directory of directories.sort()) {
    for (const file of (await readdir(path.join(migrationsDir, directory))).sort())
      contents[`${directory}/${file}`] = await readFile(path.join(migrationsDir, directory, file))
  }

  return contents
}

/**
 * 为漂移和损坏检查创建本次测试拥有的叶子目录
 */
async function createCheckFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'elmino-schema-check-test-'))

  onTestFinished(() => rm(temporary, { recursive: true, force: true }))
  return temporary
}
