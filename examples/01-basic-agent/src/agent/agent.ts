import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { createId, throwSettledErrors } from '@elmino/shared'
import { createModel } from '../model/deepseek'
import { runtime } from '../runtime/runtime'
import { createStorage } from '../storage/storage'
import { tools } from '../tool/write-note'

/** 用真实 DeepSeek 模型调用写文件工具，运行记录持久化到独立临时目录 */
export async function runAgent() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-basic-agent-'))
  const cwd = path.join(dataDir, 'workspace')
  await mkdir(cwd)
  const agent = defineAgent({
    id: 'writer',
    systemPrompt: '调用 write_note 将用户要求的内容写入文件，工具返回后说明结果，不重复写入',
    runtime,
    tools,
  })
  const store = await createStorage(dataDir)
  let engine: AgentEngine | undefined
  try {
    engine = AgentEngine.create({ writer: agent })
    const execution = engine.run({
      agentId: agent.id,
      threadId: createId('thread'),
      turnId: createId('turn'),
      model,
      signal: AbortSignal.timeout(60_000),
      location: {
        workspaceId: createId('workspace'),
        workspaceKind: 'project',
        workspaceRoot: cwd,
        cwd,
        dir: '.',
      },
      // 本例只在新建的临时工作区内执行固定文件写入
      approvalMode: 'fullAccess',
      input: [{ type: 'text', text: '请使用 write_note 将 Hello from elmino 写入 result.txt' }],
    }, store)
    const [, message] = await Promise.all([execution.accepted, execution.completed])
    console.log('Agent 回复：', message ? extractText(message) : '本次运行没有文本结果')
    console.log('文件内容：', await readFile(path.join(cwd, 'result.txt'), 'utf8'))
    console.log('示例数据目录：', dataDir)
  }
  finally {
    const engineResults = await Promise.allSettled([engine?.close()])
    const storeResults = await Promise.allSettled([store.close()])
    throwSettledErrors([...engineResults, ...storeResults], '关闭 Agent 失败', true)
  }
}
