import type { ServerOptions, ServerStartOptions } from '../server/types'
import { HttpOriginsSchema, ListenPortSchema, NonBlankStringSchema, TrimmedStringSchema } from '@elmino/schema'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

/** 定义时只读取 HTTP 授权和 CORS；显式配置不受同名环境变量影响 */
export function serverEnvironment(options: Pick<ServerOptions, 'apiKey' | 'corsOrigins'>) {
  const env = createEnv({
    server: {
      ELMINO_SERVER_KEY: NonBlankStringSchema.optional(),
      ELMINO_CORS_ORIGINS: z.string().default('').transform(value => value.split(',').map(item => item.trim()).filter(Boolean)).pipe(HttpOriginsSchema),
    },
    runtimeEnv: {
      ELMINO_SERVER_KEY: options.apiKey === null ? undefined : options.apiKey ?? process.env.ELMINO_SERVER_KEY?.trim(),
      ELMINO_CORS_ORIGINS: options.corsOrigins === undefined ? process.env.ELMINO_CORS_ORIGINS : undefined,
    },
    emptyStringAsUndefined: true,
    onValidationError: () => { throw new TypeError('Server 授权或 CORS 环境配置无效') },
  })
  const corsOrigins = options.corsOrigins === undefined ? env.ELMINO_CORS_ORIGINS : HttpOriginsSchema.parse(options.corsOrigins)
  return { ELMINO_SERVER_KEY: env.ELMINO_SERVER_KEY, ELMINO_CORS_ORIGINS: corsOrigins }
}

/** 首次监听时读取端口和主机；仅验证实际采用的配置，不加载任何环境文件 */
export function serverStartEnvironment(options: Pick<ServerStartOptions, 'port' | 'hostname'>) {
  return createEnv({
    server: {
      ELMINO_PORT: z.coerce.number().pipe(ListenPortSchema).default(3000),
      ELMINO_HOST: TrimmedStringSchema.default('127.0.0.1'),
    },
    runtimeEnv: {
      ELMINO_PORT: options.port ?? process.env.ELMINO_PORT?.trim(),
      ELMINO_HOST: options.hostname ?? process.env.ELMINO_HOST?.trim(),
    },
    emptyStringAsUndefined: true,
    onValidationError: () => { throw new TypeError('Server ELMINO_HOST 或 ELMINO_PORT 环境配置无效') },
  })
}
