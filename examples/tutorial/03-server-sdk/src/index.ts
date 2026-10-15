/**
 * Tutorial 03 · 通过 Server 与 SDK 调用 Agent
 *
 * 学习目标：区分服务端资源装配、HTTP 接入和客户端提交任务的职责
 * 运行：在仓库根执行 pnpm example:server-sdk
 * 预期现象：Server 常驻等待请求；另一个终端的 SDK 客户端执行任务后退出
 *
 * 阅读顺序：先看 app/run.ts，再按其中的 import 阅读 Agent、模型和运行环境
 * 本文件只负责启动和报告入口错误；具体能力不写在启动入口中
 */
import { runExample } from './app/run'

runExample().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
