/**
 * Reference · 用 Hooks 扩展执行行为
 *
 * 学习目标：观察上下文注入、工具参数改写/阻断，以及当前 Turn 的清理回调
 * 运行：在仓库根执行 pnpm example:agent-hooks
 * 预期现象：按顺序打印启动、工具、快照与清理日志，结束后展示便签内容
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
