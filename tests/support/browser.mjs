import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Rolldown } from 'tsdown'

const run = promisify(execFile)

/** 对浏览器公开入口进行无 Node 类型编译与完整打包，禁止依赖隐式 Node polyfill */
export async function verifyBrowserConsumer(root, dir, entry) {
  await writeFile(path.join(dir, 'tsconfig.browser.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      lib: ['ES2024', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: [entry],
  }, null, 2))
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.browser.json'], { cwd: dir })
  const bundle = await Rolldown.rolldown({
    input: path.join(dir, entry),
    platform: 'browser',
    onLog(level, log, handler) {
      if (level === 'warn' && log.code === 'UNRESOLVED_IMPORT')
        throw new Error(log.message)
      handler(level, log)
    },
  })
  try {
    const { output } = await bundle.write({ dir: path.join(dir, 'browser'), format: 'es' })
    for (const chunk of output) {
      if (chunk.type !== 'chunk')
        continue
      assert.deepEqual(chunk.imports, [], `浏览器产物仍有外部依赖: ${chunk.fileName}`)
      assert.deepEqual(chunk.dynamicImports, [], `浏览器产物仍有动态外部依赖: ${chunk.fileName}`)
      if (chunk.isEntry)
        await run(process.execPath, [path.join(dir, 'browser', chunk.fileName)], { cwd: dir, timeout: 30_000 })
    }
  }
  finally {
    await bundle.close()
  }
}
