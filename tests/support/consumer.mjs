import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { verifyBrowserConsumer } from './browser.mjs'

const run = promisify(execFile)
/** 只有显式消费适配器时才安装的外部能力，基础 SDK 必须保持隔离 */
const sdkAdapterPeers = ['react', '@orpc/tanstack-query', '@tanstack/query-core']
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
  '@orpc/server',
  'hono',
  '@hono/node-server',
  '@t3-oss/env-core',
  '@opentelemetry/api',
  ...sdkAdapterPeers,
]

/** 沿真实相对导入收集消费程序和所属夹具，复制时为 NodeNext 补齐产物后缀 */
async function readConsumer(root, name, variant = 'consumer') {
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
  const entry = `tests/${name}/${variant}.ts`
  await collect(entry)
  return { entry, files, imports }
}

/** 正式安装与集成安装分别检查依赖闭包，不能隐含引入供应商、数据库或本机实现 */
async function assertInstalledClosure(dir, name, closure, manifests, packedManifests, explicitPeers = []) {
  // 可选 peer 只有在第二阶段由消费者明确安装后才进入允许闭包
  const allowed = new Set([
    ...[...closure].flatMap(item => Object.keys(packedManifests.get(item).dependencies ?? {})),
    ...explicitPeers,
  ])
  // oRPC 1.15 的 contract/server 自身依赖 client，属于协议库传递依赖，不表示引入框架 SDK
  if (allowed.has('@orpc/contract') || allowed.has('@orpc/server'))
    allowed.add('@orpc/client')
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

/**
 * 使用同一份真实源码验证严格 NodeNext、运行结果与浏览器产物
 */
async function verifyProgram(root, dir, consumer, browser) {
  // 先复制消费入口及实际夹具，禁止通过工作区源码路径绕过发布出口
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
  if (browser)
    await verifyBrowserConsumer(root, dir, consumer.entry)
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
  await verifyProgram(root, dir, consumer, ['schema', 'request', 'protocol', 'api', 'sdk'].includes(name))
  if (name === 'sdk') {
    // 第一阶段已经证明基础 SDK 不会自动装入可选 peer，适配器单独显式安装
    const sdk = packedManifests.get(name)
    for (const peer of sdkAdapterPeers) {
      const version = sdk.peerDependencies?.[peer]
      assert.ok(typeof version === 'string' && !/^(?:workspace:|catalog:|file:|link:)/u.test(version), `SDK 可选 peer 版本未正常发布: ${peer}`)
      assert.equal(sdk.peerDependenciesMeta?.[peer]?.optional, true, `SDK peer 不应成为基础必装依赖: ${peer}`)
      dependencies[peer] = version
    }
    // 类型版本来自 SDK 按根 catalog 安装后的实际依赖，不再维护另一份版本常量
    const reactTypes = JSON.parse(await readFile(path.join(root, 'packages/sdk/node_modules/@types/react/package.json'), 'utf8'))
    devDependencies['@types/react'] = reactTypes.version
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      packageManager,
      dependencies,
      devDependencies,
    }, null, 2))
    await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: dir, maxBuffer: 5 * 1024 * 1024 })
    await assertInstalledClosure(dir, `${name}/adapters`, closure, manifests, packedManifests, sdkAdapterPeers)
    const adapters = await readConsumer(root, name, 'adapters')
    await verifyProgram(root, dir, adapters, true)
  }
}
