/**
 * Reference · 用 Hooks 扩展执行行为 · 从这里开始阅读
 *
 * 本例要讲：观察上下文注入、工具参数改写/阻断，以及当前 Turn 的清理回调
 * 运行命令：pnpm example:agent-hooks
 * 预期结果：按顺序打印启动、工具、快照与清理日志，结束后展示便签内容
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'
import { createWriter } from '../agent/agent'
import { createModel } from '../model/deepseek'
import { createTerminalOutput } from '../terminal/terminal'

/** 固定便签任务展示 Hooks 的实际调用顺序 */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-agent-hooks-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  // 第 1 步：把宿主日志函数传给 Agent，hooks/hooks.ts 展示各 Hook 的职责
  const agent = createWriter(message => console.log(message))
  const onRuntimeEvent = createTerminalOutput()
  // 第 2 步：仍使用普通单次入口，Hooks 会由真实 Loop 在相应阶段调用
  const result = await runAgent({
    agent,
    model,
    store: sqliteStore({ dataDir }),
    workspace: { id: 'example', rootDir },
    // 这里演示成功路径；tests/hooks.test.ts 另行验证策略阻断时不会产生文件
    input: '请调用 write_note 保存内容为 Hello from hooks 的便签',
    signal: AbortSignal.timeout(60_000),
    onRuntimeEvent,
  })
  // 第 3 步：回到这里时 Turn 清理回调已经执行，再查看日志顺序和产物
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '任务尚未完成')
  process.stdout.write('\n')
  console.log('文件内容：', await readFile(path.join(rootDir, 'result.txt'), 'utf8'))
  console.log('示例数据目录：', dataDir)
}
