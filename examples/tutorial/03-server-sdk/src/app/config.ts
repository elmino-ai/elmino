/**
 * 配置读取：把每个示例自己的环境变量转换成明确的服务端/客户端参数
 *
 * 从示例目录启动时，Node 已通过 --env-file-if-exists=.env 加载本地配置
 * 这里仅校验并计算配置，不创建 Server、不打开数据库，也不读取模型供应商凭据
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Server 与独立开发客户端共用连接配置，模型凭据仅由 Server 读取 */
export function readConfig() {
  const env = z.object({
    // Server 和 SDK 共用的开发凭据；生产宿主也可以改为自己的 authorize 策略
    SERVER_KEY: z.string().trim().min(1, '请在示例 .env 中配置 SERVER_KEY'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    // 可单独覆盖客户端连接地址；缺省时根据下面的 HOST 与 PORT 计算
    SERVER_URL: z.url().optional(),
    // 默认位置锚定示例目录而不是启动终端的 cwd，重启继续使用同一份运行记录
    DATA_DIR: z.string().trim().min(1).default(fileURLToPath(new URL('../../.elmino', import.meta.url))),
    // 浏览器调用需要匹配允许的 Origin；纯 Node 客户端不受浏览器 CORS 策略限制
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  }).parse(process.env)
  const corsOrigins = env.CORS_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)
  for (const origin of corsOrigins) {
    if (new URL(origin).origin !== origin)
      throw new Error('CORS_ORIGINS 请填写以逗号分隔的完整来源地址，不包含路径')
  }
  const host = env.HOST.includes(':') ? `[${env.HOST}]` : env.HOST
  return {
    key: env.SERVER_KEY,
    hostname: env.HOST,
    port: env.PORT,
    serverUrl: env.SERVER_URL ?? `http://${host}:${env.PORT}`,
    dataDir: path.resolve(env.DATA_DIR),
    corsOrigins,
  }
}
