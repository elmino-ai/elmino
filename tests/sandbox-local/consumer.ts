/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Sandbox } from '@elmino/sandbox'
import path from 'node:path'
import { LocalSandbox } from '@elmino/sandbox-local'

const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined)
    env[key] = value
}
const sandbox: Sandbox = LocalSandbox.create({
  cwd: process.cwd(),
  env,
  shell: { kind: 'sh', path: '/bin/sh' },
})
try {
  const file = path.resolve('published.txt')
  const written = await sandbox.files.write(file, 'installed sandbox')
  if (written.error || (await sandbox.files.read(file)).content !== 'installed sandbox')
    throw new Error('打包后的文件能力无法写入和回读')
  const review = sandbox.reviewer.approval({ kind: 'file', action: 'write', filePath: file })
  if (review.decision !== 'allow')
    throw new Error('工作目录审批边界不可用')
  const result = await sandbox.shell.run('printf published-shell', { yield: 1 })
  if (result.status !== 'exited' || result.output !== 'published-shell')
    throw new Error('打包后的命令执行不可用')
}
finally { await sandbox.shell.dispose() }
