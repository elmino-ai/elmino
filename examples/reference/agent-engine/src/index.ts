/**
 * Reference · 直接管理 AgentEngine
 *
 * 学习目标：复用线程完成两轮任务，并在重建 Engine 后恢复原来的审批中断
 * 运行：在仓库根执行 pnpm example:agent-engine
 * 预期现象：输入 y 才写文件；其他输入保留待审批状态并退出
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
