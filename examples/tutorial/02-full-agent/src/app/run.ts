/**
 * Tutorial 02 · 单次任务的完整配置 · 从这里开始阅读
 *
 * 本例要讲：在最简单调用上增加执行模式、超时、实时事件和结果检查
 * 运行命令：pnpm example:full-agent
 * 预期结果：实时打印可见思考与回复，结束后显示任务身份和 result.txt 的内容
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
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
  // 第 1 步：先检查凭据，再创建独立工作区，避免配置错误时打开执行资源
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-full-agent-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  // 第 2 步：前 5 项与 Basic 相同，后面的可选项逐一控制本次任务
  const result = await runAgent({
    agent: writer,
    model,
    store: sqliteStore({ dataDir }),
    workspace: { id: 'example', rootDir },
    input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
    // 显式展示默认值：fullAccess 跳过普通工具审批，本例只写入新建的临时工作区
    // 人工审批还需工具声明 approval: auto 并使用 request 模式，见 agent-engine 示例
    approvalMode: 'fullAccess',
    // 显式展示默认调度策略；本例没有子任务工具，添加此配置不会自动产生子任务
    subagentMode: 'explicitOnly',
    // 限制整次任务的运行时间
    signal: AbortSignal.timeout(60_000),
    // 打印模型返回的可见思考与回复
    onRuntimeEvent: createTerminalOutput(),
  })
  // 第 3 步：先检查完成状态，再读取工具产物；未完成时文件可能尚未生成
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '任务尚未完成')
  process.stdout.write('\n')
  console.log('执行状态：', result.status)
  // 这些 ID 可用于查询存储事实；本次入口仍是新线程，多轮与恢复见 AgentEngine
  console.log('线程 ID：', result.threadId)
  console.log('Turn ID：', result.turnId)
  console.log('文件内容：', await readFile(path.join(rootDir, 'result.txt'), 'utf8'))
  console.log('示例数据目录：', dataDir)
}
