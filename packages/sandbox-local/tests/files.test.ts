import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createTestSandbox } from './support/sandbox.js'

/** -------------------- 常量 -------------------- */
/** 测试路径稳定前缀 */
const testPathPrefix = 'elmino'

/** -------------------- 测试 -------------------- */
test('local sandbox serializes concurrent edits across instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-concurrent-`))

  try {
    const filePath = path.join(root, 'src', 'main.ts')

    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'first target\nsecond target\n', 'utf8')

    const first = createTestSandbox(root)
    const second = createTestSandbox(root)
    const results = await Promise.all([
      first.files.edit(filePath, 'first target', 'first changed'),
      second.files.edit(filePath, 'second target', 'second changed'),
    ])

    expect(results.every(result => !result.error)).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('first changed\nsecond changed\n')
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('local sandbox conditionally writes the expected file revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-revision-`))

  try {
    const filePath = path.join(root, 'draft.md')
    const files = createTestSandbox(root).files
    const created = await files.write(filePath, '第一版')
    const saved = await files.write(filePath, '第二版', {
      expectedRevision: created.revision,
    })
    const stale = await files.write(filePath, '过期草稿', {
      expectedRevision: created.revision,
    })

    expect(created.revision).toMatch(/^[a-f\d]{64}$/u)
    expect(saved).toMatchObject({ revision: expect.stringMatching(/^[a-f\d]{64}$/u) })
    expect(saved.revision).not.toBe(created.revision)
    expect(stale).toMatchObject({ conflict: true, revision: saved.revision })
    expect(await readFile(filePath, 'utf8')).toBe('第二版')
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('local sandbox reports a conflict when the conditionally written file was deleted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-deleted-`))

  try {
    const filePath = path.join(root, 'deleted.txt')
    const files = createTestSandbox(root).files
    const created = await files.write(filePath, '即将删除')

    await rm(filePath)

    expect(await files.write(filePath, '不应恢复', {
      expectedRevision: created.revision,
    })).toEqual({ conflict: true })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

test.each([undefined, null])('文件搜索在返回上限为 %s 时仍遵守大小写和目录排除规则', async (limit) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-glob-`))

  try {
    const files = createTestSandbox(root).files

    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
    await mkdir(path.join(root, 'ignored'), { recursive: true })
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n', 'utf8')
    await writeFile(path.join(root, 'src', 'Alpha.TS'), 'export {}\n', 'utf8')
    await writeFile(path.join(root, 'node_modules', 'package', 'alpha.ts'), '', 'utf8')
    await writeFile(path.join(root, 'ignored', 'alpha.ts'), '', 'utf8')

    const result = await files.glob('**/*alpha*', root, {
      limit,
      exclude: ['**/node_modules/**'],
      ignoreCase: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.files?.map(file => path.relative(root, file.path))).toEqual([
      path.join('src', 'Alpha.TS'),
    ])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('文件搜索默认限制一百条，支持自定义上限与完整结果', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-glob-limit-`))

  try {
    const names = Array.from({ length: 125 }, (_, index) => `file-${index}.txt`)
    await Promise.all(names.map(name => writeFile(path.join(root, name), '内容')))
    const files = createTestSandbox(root).files
    const defaults = await files.glob('**/*.txt', root)
    const limited = await files.glob('**/*.txt', root, { limit: 25 })
    const complete = await files.glob('**/*.txt', root, { limit: null })

    expect(defaults.error).toBeUndefined()
    expect(defaults.files).toHaveLength(100)
    expect(defaults.truncated).toBe(true)
    expect(limited.error).toBeUndefined()
    expect(limited.files).toHaveLength(25)
    expect(limited.truncated).toBe(true)
    expect(complete.error).toBeUndefined()
    expect(complete.files?.map(file => path.basename(file.path)).sort()).toEqual(names.sort())
    expect(complete.truncated).toBe(false)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('local sandbox moves complete directories without overwriting targets or crossing write boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-move-`))
  const outside = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-files-outside-`))
  try {
    const files = createTestSandbox(root).files
    const source = path.join(root, 'staging')
    const target = path.join(root, 'skills', 'imported')
    await files.write(path.join(source, 'SKILL.md'), 'skill')
    await files.write(path.join(source, 'scripts', 'run.sh'), 'script')
    expect(await files.move(source, target)).toMatchObject({ path: target })
    expect(await files.exists(source)).toBe(false)
    expect(await readFile(path.join(target, 'scripts', 'run.sh'), 'utf8')).toBe('script')
    await files.write(path.join(source, 'SKILL.md'), 'replacement')
    expect(await files.move(source, target)).toMatchObject({ error: '目标文件或目录已存在' })
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('skill')
    expect(await files.move(source, path.join(outside, 'escape'))).toMatchObject({ error: expect.stringContaining('允许写入范围') })
    expect(await files.exists(source)).toBe(true)
    expect(await files.move(source, source)).toMatchObject({ error: '源路径和目标路径不能相同' })
    await writeFile(path.join(outside, 'external.txt'), 'retained')
    expect(await files.move(path.join(outside, 'external.txt'), path.join(root, 'external.txt'))).toMatchObject({ error: expect.stringContaining('允许写入范围') })
    expect(await readFile(path.join(outside, 'external.txt'), 'utf8')).toBe('retained')
  }
  finally {
    await rm(root, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('local sandbox serializes competing directory moves to preserve the losing source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${testPathPrefix}-moves-concurrent-`))
  try {
    const files = createTestSandbox(root).files
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    const target = path.join(root, 'target')
    await files.write(path.join(first, 'content.txt'), 'first')
    await files.write(path.join(second, 'content.txt'), 'second')
    const results = await Promise.all([files.move(first, target), files.move(second, target)])
    expect(results.filter(result => !result.error)).toHaveLength(1)
    expect(results.filter(result => result.error)).toHaveLength(1)
    const remaining = await files.exists(first) ? first : second
    expect(await files.exists(remaining)).toBe(true)
    expect(await readFile(path.join(remaining, 'content.txt'), 'utf8')).not.toBe(await readFile(path.join(target, 'content.txt'), 'utf8'))
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
