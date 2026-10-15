import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'
import { writer } from '../agent/agent'
import { createModel } from '../model/deepseek'
import { createTerminalOutput } from '../terminal/terminal'

/** 展示可选执行配置、实时输出与持久化身份，运行数据保留供检查 */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-full-agent-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  const result = await runAgent({
    agent: writer,
    model,
    store: sqliteStore({ dataDir }),
    workspace: { id: 'example', rootDir },
    input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
    // 本例只在新建的临时工作区内执行固定文件写入
    approvalMode: 'fullAccess',
    subagentMode: 'explicitOnly',
    signal: AbortSignal.timeout(60_000),
    onRuntimeEvent: createTerminalOutput(),
  })
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '任务尚未完成')
  process.stdout.write('\n')
  console.log('执行状态：', result.status)
  console.log('线程 ID：', result.threadId)
  console.log('Turn ID：', result.turnId)
  console.log('文件内容：', await readFile(path.join(rootDir, 'result.txt'), 'utf8'))
  console.log('示例数据目录：', dataDir)
}
