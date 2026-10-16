/**
 * Tutorial 05 · SDK 客户端入口：先运行 04-server，再执行 pnpm example:sdk
 *
 * 连接配置来自当前示例 .env；客户端使用 ELMINO_SERVER_KEY，这个例子只需服务地址和访问凭据
 * 完成一次远程任务后客户端退出，Server 会继续等待后续请求
 * 阅读顺序：app/run.ts 的调用流程 → client/client.ts 的连接配置
 */
import { runRemoteTask } from './app/run'

runRemoteTask().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
