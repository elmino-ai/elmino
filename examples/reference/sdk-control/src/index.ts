/**
 * Reference · SDK 运行控制
 *
 * 运行 pnpm example:sdk-control，无需 .env 或模型密钥
 * 使用确定性教学模型启动临时本机 Server，依次演示停止、重新观察和审批
 * 先阅读 app/run.ts 中的 SDK 调用，再按需阅读服务端装配
 */
import { runExample } from './app/run'

/** 入口统一报告异步失败，并用退出码提示命令执行未完成 */
runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'SDK 运行控制示例失败')
  process.exitCode = 1
})
