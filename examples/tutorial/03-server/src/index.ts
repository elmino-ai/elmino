/**
 * Tutorial 03 · 启动 Agent Server
 *
 * 学习目标：装配 Agent、模型和存储，启动服务并查看 API 文档
 * 运行：在仓库根执行 pnpm example:server
 * 预期现象：Server 常驻等待请求；终端打印服务地址与 API 文档地址，按 Ctrl+C 关闭
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
