import { HttpUrlSchema, TrimmedStringSchema } from '@elmino/schema'
import { Client } from '@elmino/sdk'
import { createEnv } from '@t3-oss/env-core'

/** Node 示例入口读取自己的连接配置，浏览器继续显式创建纯 SDK Client */
export function createExampleClient() {
  const env = createEnv({
    server: {
      ELMINO_SERVER_URL: HttpUrlSchema.default('http://127.0.0.1:3000'),
      ELMINO_SERVER_KEY: TrimmedStringSchema.optional(),
    },
    // 客户端只连接已存在的服务，无需模型、存储或监听端口配置
    runtimeEnv: {
      ELMINO_SERVER_URL: process.env.ELMINO_SERVER_URL?.trim(),
      ELMINO_SERVER_KEY: process.env.ELMINO_SERVER_KEY?.trim(),
    },
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('请检查示例 .env 中的 ELMINO_SERVER_URL 与 ELMINO_SERVER_KEY')
    },
  })
  return Client.create({ baseUrl: env.ELMINO_SERVER_URL, apiKey: env.ELMINO_SERVER_KEY })
}
