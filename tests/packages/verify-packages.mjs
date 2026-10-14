/* eslint antfu/no-top-level-await: off -- 独立 Node.js 交付测试直接顺序执行异步验收 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { modelFixture } from './fixtures/models.mjs'
import { blobFixture, sqliteFixture } from './fixtures/storage.mjs'

/** 在仓库外检查真实 tarball 的运行、类型和依赖隔离，可按名称分批验收 */
const run = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const manifests = new Map()
for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory())
    continue
  const manifest = JSON.parse(await readFile(path.join(root, 'packages', entry.name, 'package.json'), 'utf8'))
  if (!manifest.private)
    manifests.set(entry.name, manifest)
}
const requested = process.argv.slice(2).flatMap(value => value.split(','))
const packageNames = requested.length
  ? [...new Set(requested.map(name => name.replace(/^@elmino\//u, '')))]
  : [...manifests.keys()]
for (const name of packageNames) assert.ok(manifests.has(name), `未知包: ${name}`)

/** 将实际内部依赖闭包全部解析到同批 tarball，保留发布 manifest 的版本声明 */
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
// 真实集成夹具的数据库适配器只作为消费者开发依赖，Engine 的发布依赖仍保持可替换
const fixturePackages = new Map([['engine', ['store-sqlite']]])
const packedNames = new Set(packageNames.flatMap(name => [
  ...dependencyClosure(name),
  ...(fixturePackages.get(name) ?? []).flatMap(item => [...dependencyClosure(item)]),
]))
const archives = new Map()
const packedManifests = new Map()
for (const name of packedNames) {
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
    assert.ok(!dependency.startsWith('@qygent/'), dependency)
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
  archives.set(name, archive)
  packedManifests.set(name, manifest)
}

/** 仅根据真实包依赖决定哪些 SDK、原生实现和引擎能力允许随安装进入 */
const isolatedDependencies = [
  'openai',
  '@anthropic-ai/sdk',
  'zod',
  'p-queue',
  'drizzle-orm',
  'dayjs',
  '@lydell/node-pty',
  '@vscode/ripgrep',
]
const nodeTypes = JSON.parse(await readFile(path.join(root, 'node_modules/@types/node/package.json'), 'utf8'))
/** 检查正式包安装和带明确夹具依赖的集成安装，各自只能含其实际依赖闭包 */
async function assertInstalledClosure(dir, name, closure) {
  const allowed = new Set([...closure].flatMap(item => Object.keys(packedManifests.get(item).dependencies ?? {})))
  const installed = await readdir(path.join(dir, 'node_modules/.pnpm'))
  assert.ok(!installed.some(entry => entry.startsWith('@qygent+')))
  for (const dependency of isolatedDependencies) {
    const prefix = `${dependency.replace('/', '+')}@`
    assert.equal(installed.some(entry => entry.startsWith(prefix)), allowed.has(dependency), `${name}: ${dependency}`)
  }
  for (const item of manifests.keys()) {
    const present = installed.some(entry => entry.startsWith(`@elmino+${item}@`))
    assert.equal(present, closure.has(item), `${name}: @elmino/${item}`)
  }
}

for (const name of packageNames) {
  let fixture
  if (name === 'store')
    fixture = blobFixture
  else if (name === 'store-sqlite')
    fixture = sqliteFixture
  else if (['llm', 'llm-openai', 'llm-anthropic'].includes(name))
    fixture = modelFixture(name)
  else
    fixture = await readFile(new URL(`./fixtures/${name}.ts`, import.meta.url), 'utf8')

  const productionClosure = dependencyClosure(name)
  const extraPackages = fixturePackages.get(name) ?? []
  const closure = new Set([
    ...productionClosure,
    ...extraPackages.flatMap(item => [...dependencyClosure(item)]),
  ])
  const allowed = new Set([...closure].flatMap(item => Object.keys(packedManifests.get(item).dependencies ?? {})))
  const dependencies = { [`@elmino/${name}`]: `file:${archives.get(name)}` }
  const devDependencies = { '@types/node': nodeTypes.version }
  for (const item of extraPackages)
    devDependencies[`@elmino/${item}`] = `file:${archives.get(item)}`
  // 夹具直接消费的公开类型和构造入口也必须是其能力包已有的依赖
  for (const match of fixture.matchAll(/from ['"](@elmino\/[^'"]+|zod)['"]/gu)) {
    const imported = match[1].startsWith('@elmino/') ? match[1].split('/').slice(0, 2).join('/') : match[1]
    if (imported === `@elmino/${name}` || imported in devDependencies)
      continue
    assert.ok(allowed.has(imported), `${name} 消费了依赖闭包之外的入口: ${imported}`)
    dependencies[imported] = imported.startsWith('@elmino/')
      ? `file:${archives.get(imported.slice('@elmino/'.length))}`
      : [...closure].map(item => packedManifests.get(item).dependencies?.[imported]).find(Boolean)
  }
  if (name === 'runtime' || name === 'tool' || name === 'agent' || name === 'engine')
    dependencies['@elmino/sandbox'] = `file:${archives.get('sandbox')}`
  const dir = await mkdtemp(path.join(tmpdir(), `elmino-${name}-consumer-`))
  const overrides = [...archives].map(([item, archive]) =>
    `  '@elmino/${item}': ${JSON.stringify(`file:${archive}`)}\n`,
  ).join('')
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), `overrides:\n${overrides}`)
  console.log(`验证 @elmino/${name}：${dir}`)
  if (extraPackages.length) {
    assert.ok(!productionClosure.has('store-sqlite'), `${name} 正式依赖绑定了数据库实现`)
    assert.ok(!productionClosure.has('sandbox-local'), `${name} 正式依赖绑定了本机执行实现`)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.18.0',
      dependencies: { [`@elmino/${name}`]: `file:${archives.get(name)}` },
      devDependencies: { '@types/node': nodeTypes.version },
    }, null, 2))
    await run('pnpm', ['install', '--ignore-scripts'], { cwd: dir, maxBuffer: 5 * 1024 * 1024 })
    await assertInstalledClosure(dir, name, productionClosure)
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'pnpm@11.18.0',
    dependencies,
    devDependencies,
  }, null, 2))
  await run('pnpm', ['install', '--ignore-scripts'], { cwd: dir, maxBuffer: 5 * 1024 * 1024 })
  await assertInstalledClosure(dir, name, closure)
  if (name === 'runtime' || name === 'tool' || name === 'agent' || name === 'engine') {
    // 复用能力测试的强类型 Sandbox 夹具，生产包不依赖测试源码
    await copyFile(path.join(root, 'packages/loop/tests/support/sandbox.ts'), path.join(dir, 'sandbox-support.ts'))
  }
  if (name === 'engine') {
    await copyFile(path.join(root, 'packages/engine/tests/support/model.ts'), path.join(dir, 'model-support.ts'))
    await copyFile(path.join(root, 'packages/engine/tests/support/files.ts'), path.join(dir, 'files-support.ts'))
  }
  await writeFile(path.join(dir, 'consumer.ts'), fixture)
  await run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target',
    'ES2023',
    '--lib',
    'ES2023,ES2024.Promise,DOM,DOM.Iterable',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--strict',
    '--skipLibCheck',
    'false',
    '--types',
    'node',
    'consumer.ts',
  ], { cwd: dir })
  await run(process.execPath, ['consumer.js'], { cwd: dir, timeout: 30_000 })
}
console.log(`${packageNames.length} 个选定包的 tarball 内容、仓库外运行、类型和依赖隔离均通过`)
