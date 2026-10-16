/* eslint antfu/no-top-level-await: off -- 独立 Node.js 交付测试直接顺序执行异步验收 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArchive } from '../support/archive.mjs'
import { verifyConsumer } from '../support/consumer.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifests = new Map()
for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory())
    continue
  const manifest = JSON.parse(await readFile(path.join(root, 'packages', entry.name, 'package.json'), 'utf8'))
  if (!manifest.private)
    manifests.set(entry.name, manifest)
}
const publicPackages = new Set([...manifests.values()].map(manifest => manifest.name))
for (const manifest of manifests.values()) {
  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    if (version.startsWith('workspace:'))
      assert.ok(publicPackages.has(dependency), `${manifest.name} 依赖了公开能力包之外的工作区: ${dependency}`)
  }
}
const requested = process.argv.slice(2).flatMap(value => value.split(','))
const packageNames = requested.length
  ? [...new Set(requested.map(name => name.replace(/^@elmino\//u, '')))]
  : [...manifests.keys()]
for (const name of packageNames) assert.ok(manifests.has(name), `未知包: ${name}`)

/** 沿运行依赖收集同批归档，保留各包正式声明的依赖边界 */
function dependencyClosure(name, result = new Set()) {
  if (result.has(name))
    return result
  result.add(name)
  for (const dependency of Object.keys(manifests.get(name).dependencies ?? {})) {
    if (dependency.startsWith('@elmino/'))
      dependencyClosure(dependency.slice('@elmino/'.length), result)
  }
  return result
}
// 集成场景需要的具体实现只作为消费者开发依赖
const fixturePackages = new Map([
  ['engine', ['store-sqlite']],
  ['core', ['store-sqlite']],
  ['local', ['sandbox-local']],
  ['server', ['sdk']],
])
const packedNames = new Set(packageNames.flatMap(name => [
  ...dependencyClosure(name),
  ...(fixturePackages.get(name) ?? []).flatMap(item => [...dependencyClosure(item)]),
]))
const archives = new Map()
const packedManifests = new Map()
for (const name of packedNames) {
  const { archive, manifest } = await verifyArchive(root, name, manifests)
  archives.set(name, archive)
  packedManifests.set(name, manifest)
}
for (const name of packageNames) {
  await verifyConsumer({
    root,
    name,
    manifests,
    archives,
    packedManifests,
    dependencyClosure,
    extraPackages: fixturePackages.get(name) ?? [],
  })
}
console.log(`${packageNames.length} 个选定包的 tarball 内容、仓库外运行、类型和依赖隔离均通过`)
