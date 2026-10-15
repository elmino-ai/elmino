/**
 * Reference · 显式派生子任务 · 从这里开始阅读
 *
 * 本例要讲：通过两个独立工具调用派生两个子任务，等待结果后由父模型汇总
 * 运行命令：pnpm example:subagents
 * 预期结果：打印子任务状态与模型回答，失败结果也会如实交还父模型
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'
import { coordinator } from '../agent/agent'
import { createModel } from '../model/deepseek'
import { createTerminalOutput } from '../terminal/terminal'

/** 两个独立问题各创建一个子任务，父模型等待并汇总 */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-subagents-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  const output = createTerminalOutput()
  // 第 1 步：父任务走单次入口，Engine 会为工具注入真正的子任务控制服务
  const result = await runAgent({
    agent: coordinator,
    model,
    store: sqliteStore({ dataDir }),
    workspace: { id: 'example', rootDir },
    // 第 2 步：两个独立任务对应两个工具调用，派生与等待实现在 tool/delegate.ts
    input: '请调用两次 delegate_task，分别解释 Thread 和 Turn 的含义，各用一句话回答，收到两个子任务结果后汇总',
    // 必须通过本例明确声明的委派工具派生，不是开启一个自动分工开关
    subagentMode: 'explicitOnly',
    signal: AbortSignal.timeout(120_000),
    onRuntimeEvent: (event) => {
      // 子线程状态有独立事件；文字片段交给通用终端输出器展示
      if (event.type === 'thread.child.updated')
        console.log('\n子任务状态：', event.payload)
      else
        output(event)
    },
  })
  // 第 3 步：这里检查父任务状态；子任务的失败会作为工具结果回传给父模型
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '父任务尚未完成')
  console.log('\n示例数据目录：', dataDir)
}
