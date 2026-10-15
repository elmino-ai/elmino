/**
 * Reference · 直接管理 AgentEngine · 从这里开始阅读
 *
 * 本例要讲：复用线程完成两轮任务，并在重建 Engine 后恢复原来的审批中断
 * 运行命令：pnpm example:agent-engine
 * 预期结果：输入 y 才写文件；其他输入保留待审批状态并退出
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
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
  // 第 1 步：宿主准备目录与交互能力，Engine 不替应用选择工作区
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-agent-engine-'))
  await mkdir(path.join(dataDir, 'workspace'))
  // 两分钟覆盖两轮对话与等待审批；生产应用可改为自己的取消信号
  const signal = AbortSignal.timeout(120_000)
  console.log('示例数据目录：', dataDir)
  const onRuntimeEvent = createTerminalOutput()
  // 第 2 步：核心生命周期示范在 engine/run.ts，终端实现只通过回调注入
  const result = await runEngineExample({
    dataDir,
    // 传工厂而非固定实例，恢复时才能根据原 Turn 的冻结配置重建模型
    model: createModel,
    approve: payload => confirmApproval(payload, signal),
    signal,
    onRuntimeEvent,
  })
  process.stdout.write('\n')
  // 第 3 步：打印同一线程的两个 Turn 身份，用来对照存储中的运行记录
  console.log('执行状态：', result.status)
  console.log('线程 ID：', result.threadId)
  console.log('第一轮 Turn ID：', result.firstTurnId)
  console.log('第二轮 Turn ID：', result.turnId)
  if (result.status === 'completed')
    console.log('文件内容：', await readFile(path.join(dataDir, 'workspace', 'result.txt'), 'utf8'))
  else
    console.log('审批尚未确认，文件未写入，待审批记录已保留')
}
