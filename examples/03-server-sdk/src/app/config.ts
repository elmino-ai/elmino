import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Server 与独立开发客户端共用连接配置，模型凭据仅由 Server 读取 */
export function readConfig() {
  const env = z.object({
    SERVER_KEY: z.string().trim().min(1, '请在示例 .env 中配置 SERVER_KEY'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    SERVER_URL: z.url().optional(),
    DATA_DIR: z.string().trim().min(1).default(fileURLToPath(new URL('../../.elmino', import.meta.url))),
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
