/**
 * Reference · 控制正在运行的 Turn
 *
 * 学习目标：向准确的活跃 Turn 提交引导，或中断并等待它完成结算
 * 运行：在仓库根执行 pnpm example:turn-control
 * 预期现象：等待工具启动后可输入补充要求；输入 /stop 则中断当前任务
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
