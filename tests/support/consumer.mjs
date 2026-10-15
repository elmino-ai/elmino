import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { verifyBrowserConsumer } from './browser.mjs'

const run = promisify(execFile)
const isolatedDependencies = [
  'openai',
  '@anthropic-ai/sdk',
  'zod',
  'p-queue',
  'drizzle-orm',
  'dayjs',
  '@lydell/node-pty',
  '@vscode/ripgrep',
  '@orpc/client',
  '@opentelemetry/api',
]

/** 沿真实相对导入收集消费程序和所属夹具，复制时为 NodeNext 补齐产物后缀 */
async function readConsumer(root, name) {
  const files = new Map()
  const imports = new Set()
  async function collect(file) {
    if (files.has(file))
      return
    assert.ok(file.startsWith('tests/') || /^packages\/[^/]+\/tests\//u.test(file), `消费者直接引用了生产源码: ${file}`)
    const source = await readFile(path.join(root, file), 'utf8')
    files.set(file, source)
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const replacements = []
    for (const node of parsed.statements) {
      if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
        || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
        continue
      }
      const specifier = node.moduleSpecifier.text
      if (!specifier.startsWith('.')) {
        imports.add(specifier)
        continue
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      assert.ok(!target.startsWith('../') && !path.posix.isAbsolute(target), `夹具导入越出仓库: ${specifier}`)
      const module = target.replace(/\.(?:js|ts)$/u, '')
      await collect(`${module}.ts`)
      const output = `${specifier.replace(/\.(?:js|ts)$/u, '')}.js`
      replacements.push({ start: node.moduleSpecifier.getStart(parsed) + 1, end: node.moduleSpecifier.end - 1, output })
    }
    let content = source
    for (const { start, end, output } of replacements.reverse())
      content = content.slice(0, start) + output + content.slice(end)
    files.set(file, content)
  }
  const entry = `tests/${name}/consumer.ts`
  await collect(entry)
  return { entry, files, imports }
}

/** 正式安装与集成安装分别检查依赖闭包，不能隐含引入供应商、数据库或本机实现 */
async function assertInstalledClosure(dir, name, closure, manifests, packedManifests) {
  const allowed = new Set([...closure].flatMap(item => Object.keys(packedManifests.get(item).dependencies ?? {})))
  const installed = await readdir(path.join(dir, 'node_modules/.pnpm'))
  for (const dependency of isolatedDependencies) {
    const prefix = `${dependency.replace('/', '+')}@`
    assert.equal(installed.some(entry => entry.startsWith(prefix)), allowed.has(dependency), `${name}: ${dependency}`)
  }
  for (const item of manifests.keys()) {
    const present = installed.some(entry => entry.startsWith(`@elmino+${item}@`))
    assert.equal(present, closure.has(item), `${name}: @elmino/${item}`)
  }
}

/** 在仓库外安装同批归档，严格编译并运行当前领域的真实消费程序 */
export async function verifyConsumer({ root, name, manifests, archives, packedManifests, dependencyClosure, extraPackages }) {
  const consumer = await readConsumer(root, name)
  const productionClosure = dependencyClosure(name)
  const closure = new Set([
    ...productionClosure,
    ...extraPackages.flatMap(item => [...dependencyClosure(item)]),
  ])
  const allowed = new Set([...closure].flatMap(item => Object.keys(packedManifests.get(item).dependencies ?? {})))
  const dependencies = { [`@elmino/${name}`]: `file:${archives.get(name)}` }
  const nodeTypes = JSON.parse(await readFile(path.join(root, 'node_modules/@types/node/package.json'), 'utf8'))
  const { packageManager } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const devDependencies = { '@types/node': nodeTypes.version }
  for (const item of extraPackages)
    devDependencies[`@elmino/${item}`] = `file:${archives.get(item)}`
  for (const specifier of consumer.imports) {
    if (!specifier.startsWith('@elmino/') && specifier !== 'zod')
      continue
    const imported = specifier.startsWith('@elmino/') ? specifier.split('/').slice(0, 2).join('/') : specifier
    if (imported === `@elmino/${name}` || imported in devDependencies)
      continue
    assert.ok(allowed.has(imported), `${name} 消费了依赖闭包之外的入口: ${imported}`)
    dependencies[imported] = imported.startsWith('@elmino/')
      ? `file:${archives.get(imported.slice('@elmino/'.length))}`
      : [...closure].map(item => packedManifests.get(item).dependencies?.[imported]).find(Boolean)
  }
  const dir = await mkdtemp(path.join(tmpdir(), `elmino-${name}-consumer-`))
  const overrides = [...archives].map(([item, archive]) =>
    `  '@elmino/${item}': ${JSON.stringify(`file:${archive}`)}\n`,
  ).join('')
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), `hoist: false\noverrides:\n${overrides}`)
  console.log(`验证 @elmino/${name}：${dir}`)
  if (extraPackages.length) {
    assert.ok(!productionClosure.has('store-sqlite'), `${name} 正式依赖绑定了数据库实现`)
    assert.ok(!productionClosure.has('sandbox-local'), `${name} 正式依赖绑定了本机执行实现`)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      packageManager,
      dependencies: { [`@elmino/${name}`]: `file:${archives.get(name)}` },
      devDependencies: { '@types/node': nodeTypes.version },
    }, null, 2))
    // 验收生成的临时清单随后还会添加集成依赖，不继承 CI 默认的冻结锁文件策略
    await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: dir, maxBuffer: 5 * 1024 * 1024 })
    await assertInstalledClosure(dir, name, productionClosure, manifests, packedManifests)
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    packageManager,
    dependencies,
    devDependencies,
  }, null, 2))
  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: dir, maxBuffer: 5 * 1024 * 1024 })
  await assertInstalledClosure(dir, name, closure, manifests, packedManifests)
  for (const [file, source] of consumer.files) {
    const target = path.join(dir, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, source)
  }
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
    '--rootDir',
    '.',
    '--outDir',
    'dist',
    consumer.entry,
  ], { cwd: dir })
  await run(process.execPath, [path.join('dist', consumer.entry.replace(/\.ts$/u, '.js'))], { cwd: dir, timeout: 30_000 })
  if (name === 'request' || name === 'protocol')
    await verifyBrowserConsumer(root, dir, consumer.entry)
}
