/**
 * Reference · 控制正在运行的 Turn · 从这里开始阅读
 *
 * 本例要讲：向准确的活跃 Turn 提交引导，或中断并等待它完成结算
 * 运行命令：pnpm example:turn-control
 * 预期结果：等待工具启动后可输入补充要求；输入 /stop 则中断当前任务
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { runControlExample } from '../engine/control'
import { createModel } from '../model/deepseek'
import { createTerminalOutput } from '../terminal/terminal'

/** 用一次终端输入演示运行中引导，输入 /stop 则中断当前 Turn */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-turn-control-'))
  await mkdir(path.join(dataDir, 'workspace'))
  const signal = AbortSignal.timeout(120_000)
  const onRuntimeEvent = createTerminalOutput()
  console.log('示例数据目录：', dataDir)
  // 第 1 步：Engine 先启动任务，等待工具进入运行后才调用下面的 control
  const result = await runControlExample({
    dataDir,
    model,
    signal,
    onRuntimeEvent,
    // 第 2 步：操作直接使用原 Engine、请求身份和 Store，不重新创建任务
    control: async ({ engine, request, store }) => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const text = await terminal.question('\n请输入补充需求，或输入 /stop 中断当前任务 ', { signal })
        const { agentId, threadId, turnId } = request
        // 路径 A：停止准确的 turnId，并等待工具与本次执行退出
        if (text.trim() === '/stop') {
          await engine.interrupt({ agentId, threadId, turnId, store, reason: '用户从终端中断任务' })
          return 'interrupt'
        }
        if (!text.trim())
          throw new Error('补充需求不能为空')
        // 路径 B：追加到当前 Turn，不打断正在等待的工具，也不创建新 Turn
        await engine.steer({ agentId, threadId, turnId, store, text })
        console.log('补充需求已接纳，当前工具结束后交给模型')
        return 'steer'
      }
      finally { terminal.close() }
    },
  })
  // 第 3 步：最终持久化状态可能是 completed，也可能是主动中断的 interrupted
  console.log('\n执行状态：', result.status)
  console.log('线程 ID：', result.threadId)
  console.log('Turn ID：', result.turnId)
}
