import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** 在仓库外检查真实 tarball 的运行、类型和依赖隔离 */
const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const packageNames = ['llm', 'llm-openai', 'llm-anthropic']
const archives = new Map()

for (const name of packageNames) {
  const source = JSON.parse(await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8'))
  const archive = path.join(root, 'dist/packs', `elmino-${name}-${source.version}.tgz`)
  const { stdout: content } = await run('tar', ['-tzf', archive])
  const { stdout: metadata } = await run('tar', ['-xOf', archive, 'package/package.json'])
  const manifest = JSON.parse(metadata)
  const files = new Set(content.trim().split('\n'))

  assert.equal(manifest.name, `@elmino/${name}`)
  assert.ok(!manifest.private)
  for (const file of files) {
    assert.ok(file === 'package/package.json'
      || file.startsWith('package/dist/') || file.startsWith('package/src/'), file)
  }
  for (const entry of Object.values(manifest.exports)) {
    assert.ok(files.has(`package/${entry.import.slice(2)}`), entry.import)
    assert.ok(files.has(`package/${entry.types.slice(2)}`), entry.types)
  }
  for (const file of files) {
    if (!file.endsWith('.map'))
      continue
    const { stdout } = await run('tar', ['-xOf', archive, file])
    const map = JSON.parse(stdout)

    for (const source of map.sources)
      assert.ok(files.has(path.posix.join(path.posix.dirname(file), source)), source)
  }
  for (const [dependency, version] of Object.entries(manifest.dependencies)) {
    assert.ok(!/^(?:workspace:|catalog:|file:|link:)/u.test(version), `${dependency}: ${version}`)
    assert.ok(!dependency.startsWith('@qygent/'), dependency)
  }
  archives.set(name, archive)
}

for (const name of packageNames) {
  const dir = await mkdtemp(path.join(tmpdir(), `elmino-${name}-consumer-`))
  const dependencies = { '@elmino/llm': `file:${archives.get('llm')}` }
  const sdk = name === 'llm-openai' ? 'openai' : '@anthropic-ai/sdk'
  const Adapter = name === 'llm-openai' ? 'ResponsesProvider' : 'AnthropicMessagesProvider'

  if (name !== 'llm')
    dependencies[`@elmino/${name}`] = `file:${archives.get(name)}`
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'pnpm@11.18.0',
    dependencies,
  }, null, 2))
  // 尚未发布的内部依赖用同批 tarball 解析，保持真实打包后的版本声明不变
  await writeFile(
    path.join(dir, 'pnpm-workspace.yaml'),
    `overrides:\n  '@elmino/llm': ${JSON.stringify(`file:${archives.get('llm')}`)}\n`,
  )
  console.log(`验证 @elmino/${name}：${dir}`)
  await run('pnpm', ['install', '--ignore-scripts', '--config.verifyDepsBeforeRun=false'], {
    cwd: dir,
    maxBuffer: 5 * 1024 * 1024,
  })

  const store = await readdir(path.join(dir, 'node_modules/.pnpm'))

  assert.ok(!store.some(entry => entry.startsWith('@qygent+')))
  if (name !== 'llm-anthropic')
    assert.ok(!store.some(entry => entry.startsWith('@anthropic-ai+sdk@')))
  if (name !== 'llm-openai')
    assert.ok(!store.some(entry => entry.startsWith('openai@')))
  if (name !== 'llm')
    assert.ok(store.some(entry => entry.startsWith(`${sdk.replace('/', '+')}@`)))

  const fixture = `
import { extractText } from '@elmino/llm'
import type { Message, Provider, Request } from '@elmino/llm'
import { createToolCall } from '@elmino/llm/adapter'
import { RequestCache } from '@elmino/llm/cache'
import { ObjectParseError } from '@elmino/llm/object'
import { resolveProviderAuth } from '@elmino/llm/provider'
import type { Result } from '@elmino/llm/request'
import type { Event } from '@elmino/llm/stream'
import { EMPTY_USAGE } from '@elmino/llm/usage'
${name === 'llm' ? '' : `import { ${Adapter} } from '@elmino/${name}'`}
${name === 'llm-openai'
  ? `import { ChatCompletionsProvider } from '@elmino/llm-openai/chat-completions'
import { ResponsesProvider as Responses } from '@elmino/llm-openai/responses'`
  : ''}
const message: Message = { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }
const result: Result = { message, usage: EMPTY_USAGE }
const event: Event = { type: 'usage', usage: result.usage }
const request: Request = { system: [], messages: [], maxOutputTokens: 10 }
if (extractText(message) !== 'ok' || event.usage.input !== 0) throw new Error('公共协议无法消费')
if (createToolCall('native-call', 'tool', '{}').invalidArgs) throw new Error('工具参数无法解析')
if (resolveProviderAuth({ model: 'local', apiKeyRequired: false }, 'bearer', 'local').type !== 'none')
  throw new Error('认证策略无法消费')
RequestCache.create({ cache: { modes: ['disabled'] }, defaultCache: { mode: 'disabled' } }).resolve(request)
new ObjectParseError(result, new Error('expected'))
${name === 'llm'
  ? `const adapter: Provider | undefined = undefined
if (adapter) throw new Error('协议包不应包含适配器')`
  : `const adapter: Provider = ${Adapter}.create({ model: 'local', apiKeyRequired: false })
if (adapter.model !== 'local') throw new Error('适配器无法装配')
const client = Reflect.get(adapter, '_client') as { fetch: typeof fetch }
const response = ${name === 'llm-openai'
  ? `{ id: 'resp-local', status: 'completed',
output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
usage: { input_tokens: 1, output_tokens: 1,
input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }`
  : `{ id: 'msg-local', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
usage: { input_tokens: 1, output_tokens: 1 } }`}
client.fetch = () => Promise.resolve(new Response(JSON.stringify(response), {
  status: 200, headers: { 'content-type': 'application/json' },
}))
const generated = await adapter.generate(request)
if (extractText(generated.message) !== 'ok' || generated.usage.input !== 1)
  throw new Error('打包后的适配器无法通过 SDK 返回公共结果')`}
${name === 'llm-openai'
  ? `if (Responses !== ResponsesProvider) throw new Error('子路径与根出口不一致')
ChatCompletionsProvider.create({ model: 'local', apiKeyRequired: false })`
  : ''}
`

  await writeFile(path.join(dir, 'consumer.ts'), fixture)
  await run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--strict',
    '--skipLibCheck',
    'false',
    'consumer.ts',
  ], { cwd: dir })
  await run(process.execPath, ['consumer.js'], { cwd: dir })
}

console.log('三个包的 tarball 内容、仓库外运行、类型和依赖隔离均通过')
