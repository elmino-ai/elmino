/**
 * 客户端入口：在 Server 保持运行时，于另一个终端执行 pnpm example:server-sdk:client
 *
 * 连接配置来自当前示例 .env；客户端使用 SERVER_KEY，模型 API Key 仅由服务端使用
 * 完成一次远程任务后客户端退出，Server 会继续等待后续请求
 * 核心调用顺序见 client/run.ts
 */
import { readConfig } from '../app/config'
import { runRemoteTask } from './run'

const config = readConfig()
runRemoteTask(config.serverUrl, config.key).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
