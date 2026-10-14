import type { Arrayable } from '@elmino/shared'
import type { RecoveryStatus } from './types'
import { delay } from '@elmino/shared'
import dayjs from 'dayjs'
import { BASE_DELAY_MS, MAX_DELAY_MS, MAX_TRANSIENT_RETRIES, PROMPT_TOO_LONG_PATTERN } from '../constants/index'

/** -------------------- 核心函数 -------------------- */
/**
 * 创建默认错误恢复数据
 */
export function createRecoveryStatus(): RecoveryStatus {
  return {
    hasEscalatedOutputBudget: false,
    continuationCount: 0,
    hasAttemptedReactiveCompact: false,
    emptyResponseCount: 0,
  }
}

/**
 * 根据重试次数生成指数退避延迟，Retry-After 优先
 */
function retryDelayMs(
  attempt: number,
  retryAfterMs?: number,
) {
  if (retryAfterMs !== undefined)
    return retryAfterMs

  // 指数退避叠加轻微抖动，降低多个并发请求同时重试的概率
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
  return base + Math.floor(Math.random() * base * 0.25)
}

/**
 * 判断错误是否表示上下文超限
 */
export function isPromptTooLongError(error: unknown) {
  const message = (error instanceof Error
    ? error.message
    : String(error)).toLowerCase()

  return PROMPT_TOO_LONG_PATTERN.test(message)
}

/**
 * 带指数退避的瞬态错误重试包装
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
) {
  /** 等待下一次重试，并在 Turn 取消时立即结束退避 */
  const waitForRetry = (waitMs: number) => {
    if (!signal)
      return delay(waitMs)
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new Error('运行已中断'))

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      /** 清理退避计时器并传播原始取消原因 */
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('运行已中断'))
      }

      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, Math.max(0, waitMs))
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const result = await fn()
      return result
    }
    catch (error) {
      if (isTransientProviderError(error)) {
        if (attempt === MAX_TRANSIENT_RETRIES - 1)
          throw error

        // 429 和 529 都属于 provider 侧瞬态失败，等待后重放同一次请求
        const delayMs = retryDelayMs(attempt, retryAfterMs(error))
        await waitForRetry(delayMs)
        continue
      }

      throw error
    }
  }

  throw new Error(`瞬态错误重试次数已超过上限: ${MAX_TRANSIENT_RETRIES}`)
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断 429 限流或 529 过载等 Provider 瞬态错误
 */
export function isTransientProviderError(error: unknown) {
  const anyError = error as { status?: number, statusCode?: number, name?: string }
  const message = (error instanceof Error
    ? error.message
    : String(error)).toLowerCase()

  return anyError.status === 429
    || anyError.status === 529
    || anyError.statusCode === 429
    || anyError.statusCode === 529
    || anyError.name?.toLowerCase().includes('ratelimit')
    || anyError.name?.toLowerCase().includes('overload')
    || message.includes('429')
    || message.includes('529')
    || message.includes('rate limit')
    || message.includes('overloaded')
}

/**
 * 读取 Retry-After 响应头
 */
function retryAfterMs(error: unknown) {
  const headers = (error as {
    headers?: Headers | Record<string, Arrayable<string> | undefined>
  }).headers

  if (!headers)
    return

  const value = headers instanceof Headers
    ? headers.get('retry-after')
    : headers['retry-after'] ?? headers['Retry-After']

  const raw = Array.isArray(value) ? value[0] : value

  if (!raw)
    return

  const seconds = Number(raw)

  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)

  // Retry-After 也可能是 HTTP date，统一转成从当前时间开始的延迟
  const date = dayjs(raw)

  if (!date.isValid())
    return

  return Math.max(0, date.valueOf() - dayjs().valueOf())
}
