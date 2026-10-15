/**
 * Tutorial 01 · 最简单的 Agent
 *
 * 学习目标：用 5 个必填参数完成一次真实模型与工具调用
 * 运行：在仓库根执行 pnpm example:basic-agent
 * 预期现象：执行结束后打印模型回复，便签保存在终端给出的数据目录中
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Agent 执行失败')
  process.exitCode = 1
})
