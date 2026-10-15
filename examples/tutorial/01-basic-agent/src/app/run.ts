import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { sqliteStore } from '@elmino/store-sqlite'
import { writer } from '../agent/agent'
import { createModel } from '../model/deepseek'

/** 最简单的调用只传必填参数，等待任务结束后展示回复 */
export async function runExample() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-basic-agent-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  const result = await runAgent({
    agent: writer,
    model: createModel(),
    store: sqliteStore({ dataDir }),
    workspace: { id: 'example', rootDir },
    input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
  })
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '任务尚未完成')
  console.log('回复：', result.message ? extractText(result.message) : '')
  console.log('示例数据目录：', dataDir)
}
