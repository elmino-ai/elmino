/**
 * Tutorial 02 · 单次任务的完整配置
 *
 * 学习目标：在最简单调用上增加执行模式、超时、实时事件和结果检查
 * 运行：在仓库根执行 pnpm example:full-agent
 * 预期现象：实时打印可见思考与回复，结束后显示任务身份和 result.txt 的内容
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
