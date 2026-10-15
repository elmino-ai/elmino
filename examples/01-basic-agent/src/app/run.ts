import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { writer } from '../agent/agent'
import { createModel } from '../model/deepseek'
import { createStorage } from '../storage/storage'
import { createTerminalOutput } from '../terminal/terminal'

/** 只演示真实 DeepSeek 调用写文件工具，运行数据保留在独立临时目录 */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-basic-agent-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  const store = await createStorage(dataDir)
  try {
    const result = await runAgent({
      agent: writer,
      model,
      store,
      workspace: { id: 'example', rootDir },
      input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
      // 本例只在新建的临时工作区内执行固定文件写入
      approvalMode: 'fullAccess',
      signal: AbortSignal.timeout(60_000),
      onRuntimeEvent: createTerminalOutput(),
    })
    if (result.status !== 'completed')
      throw new Error(result.errorMessage ?? '任务尚未完成')
    process.stdout.write('\n')
    console.log('文件内容：', await readFile(path.join(rootDir, 'result.txt'), 'utf8'))
    console.log('示例数据目录：', dataDir)
  }
  finally {
    await store.close()
  }
}
