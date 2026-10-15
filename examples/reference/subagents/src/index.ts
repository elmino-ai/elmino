/**
 * Reference · 显式派生子任务
 *
 * 学习目标：通过两个独立工具调用派生两个子任务，等待结果后由父模型汇总
 * 运行：在仓库根执行 pnpm example:subagents
 * 预期现象：打印子任务状态与模型回答，失败结果也会如实交还父模型
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
