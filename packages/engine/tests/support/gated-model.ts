import { onTestFinished } from 'vitest'
import { createModel, response } from './model'

/** 模型采样可精确停在执行中，并在执行中断时按真实 signal 退出 */
export function createGatedModel(text = '任务完成') {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const model = createModel([async (request) => {
    signal = request.signal
    entered.resolve()
    await new Promise<void>((resolve, reject) => {
      /** 只由模型本次采样持有取消监听 */
      const abort = () => {
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      release.promise.then(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      })
      if (signal?.aborted)
        abort()
    })
    return response([{ type: 'text', text }])
  }])
  onTestFinished(() => release.resolve())
  return {
    ...model,
    entered: entered.promise,
    release: () => release.resolve(),
    get signal() { return signal },
  }
}
