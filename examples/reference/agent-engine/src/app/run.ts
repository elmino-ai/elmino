import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runEngineExample } from '../engine/run'
import { createModel } from '../model/deepseek'
import { confirmApproval } from '../terminal/approval'
import { createTerminalOutput } from '../terminal/terminal'

/** 宿主准备目录、模型、审批与输出，再交给显式管理的 AgentEngine */
export async function runExample() {
  // 在创建运行数据前检查凭据；恢复阶段仍按持久化模型配置重新装配
  createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-agent-engine-'))
  await mkdir(path.join(dataDir, 'workspace'))
  const signal = AbortSignal.timeout(120_000)
  console.log('示例数据目录：', dataDir)
  const onRuntimeEvent = createTerminalOutput()
  const result = await runEngineExample({
    dataDir,
    model: createModel,
    approve: payload => confirmApproval(payload, signal),
    signal,
    onRuntimeEvent,
  })
  process.stdout.write('\n')
  console.log('执行状态：', result.status)
  console.log('线程 ID：', result.threadId)
  console.log('第一轮 Turn ID：', result.firstTurnId)
  console.log('第二轮 Turn ID：', result.turnId)
  if (result.status === 'completed')
    console.log('文件内容：', await readFile(path.join(dataDir, 'workspace', 'result.txt'), 'utf8'))
  else
    console.log('审批尚未确认，文件未写入，待审批记录已保留')
}
