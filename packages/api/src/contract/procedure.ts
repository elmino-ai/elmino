import { oc } from '@orpc/contract'
import { z } from 'zod'
import { JsonValueSchema } from './schema'

/** 标准错误的可传输细节，不依赖产品业务码或 Server 异常类 */
export const ApiErrorDataSchema = z.object({
  details: z.record(z.string(), JsonValueSchema).optional(),
  issues: z.array(z.object({
    code: z.string(),
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
  })).optional(),
}).optional()

/** 所有 procedure 共用的标准错误集合 */
export const apiErrors = {
  BAD_REQUEST: { data: ApiErrorDataSchema },
  UNAUTHORIZED: { data: ApiErrorDataSchema },
  FORBIDDEN: { data: ApiErrorDataSchema },
  NOT_FOUND: { data: ApiErrorDataSchema },
  CONFLICT: { data: ApiErrorDataSchema },
  PRECONDITION_FAILED: { data: ApiErrorDataSchema },
  TIMEOUT: { data: ApiErrorDataSchema },
  PAYLOAD_TOO_LARGE: { data: ApiErrorDataSchema },
  TOO_MANY_REQUESTS: { data: ApiErrorDataSchema },
  INTERNAL_SERVER_ERROR: { data: ApiErrorDataSchema },
  SERVICE_UNAVAILABLE: { data: ApiErrorDataSchema },
} as const

/** 实际路由共用的 oRPC 契约构建器 */
export const procedure = oc.errors(apiErrors)
