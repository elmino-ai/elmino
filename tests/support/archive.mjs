import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 检查 tarball 的入口、类型、资源与依赖，返回实际安装所需的归档和声明 */
export async function verifyArchive(root, name, manifests) {
  const source = manifests.get(name)
  const archive = path.join(root, 'dist/packs', `elmino-${name}-${source.version}.tgz`)
  const { stdout: content } = await run('tar', ['-tzf', archive])
  const { stdout: metadata } = await run('tar', ['-xOf', archive, 'package/package.json'])
  const manifest = JSON.parse(metadata)
  const files = new Set(content.trim().split('\n'))
  assert.equal(manifest.name, source.name)
  assert.equal(manifest.version, source.version)
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), Object.keys(source.dependencies ?? {}).sort())
  assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(source.exports).sort())
  assert.ok(!manifest.private)
  for (const file of files) {
    assert.ok(file === 'package/package.json' || file.startsWith('package/dist/') || file.startsWith('package/src/')
      || (name === 'store-sqlite' && file.startsWith('package/drizzle/runtime/migrations/')), file)
  }
  for (const entry of Object.values(manifest.exports)) {
    assert.ok(files.has(`package/${entry.import.slice(2)}`), entry.import)
    assert.ok(files.has(`package/${entry.types.slice(2)}`), entry.types)
  }
  for (const file of files) {
    if (!file.endsWith('.map'))
      continue
    const { stdout } = await run('tar', ['-xOf', archive, file])
    for (const source of JSON.parse(stdout).sources)
      assert.ok(files.has(path.posix.join(path.posix.dirname(file), source)), source)
  }
  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    assert.ok(!/^(?:workspace:|catalog:|file:|link:)/u.test(version), `${dependency}: ${version}`)
  }
  if (name === 'loop' || name === 'engine') {
    const prompts = [...files].filter(file => file.startsWith('package/dist/prompts/template/') && file.endsWith('.md'))
    assert.equal(prompts.length, name === 'loop' ? 4 : 3, `${name} 提示词资源缺失`)
    for (const file of prompts) {
      const { stdout } = await run('tar', ['-xOf', archive, file])
      const source = path.join(root, 'packages', name, file.replace('package/dist/', 'src/'))
      assert.equal(stdout, await readFile(source, 'utf8'))
    }
  }
  if (name === 'store-sqlite') {
    const migrations = [...files].filter(file =>
      file.startsWith('package/drizzle/runtime/migrations/') && file.endsWith('.sql'),
    )
    assert.ok(migrations.length, 'SQLite 迁移资源缺失')
    for (const file of migrations) {
      const { stdout } = await run('tar', ['-xOf', archive, file])
      const source = path.join(root, 'packages/store-sqlite', file.slice('package/'.length))
      assert.equal(stdout, await readFile(source, 'utf8'))
    }
  }
  return { archive, manifest }
}
