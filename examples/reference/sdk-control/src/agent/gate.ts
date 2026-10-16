/**
 * 仅属于演示的工具门控：保证操作发生时工具确实仍在运行
 * 真实项目的长工具无需创建门控，只要正确响应自己的 signal
 */
export function createGate() {
  // 工具进入等待后通知宿主，此前不发送中断或重新观察请求
  const entered = Promise.withResolvers<void>()
  // 宿主手动放行工具；与取消信号竞争决定等待何时结束
  const released = Promise.withResolvers<void>()
  return {
    /** 宿主等待工具已进入执行阶段的通知 */
    entered: entered.promise,
    /** 宿主完成 attach 演示后允许工具正常返回 */
    release: () => released.resolve(),
    /**
     * 工具执行时等待放行，同时响应服务端任务中断
     */
    async wait(signal?: AbortSignal) {
      signal?.throwIfAborted()
      // 把 AbortSignal 转换为可与宿主放行通知竞争的拒绝 Promise
      const aborted = Promise.withResolvers<never>()
      /** 任务中断时结束门控等待，并保留原始取消原因 */
      const abort = () => aborted.reject(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      entered.resolve()
      try {
        await Promise.race([released.promise, aborted.promise])
      }
      finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}
