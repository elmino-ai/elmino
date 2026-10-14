import type { Promisable } from 'type-fest'

/** -------------------- 核心类 -------------------- */
/**
 * 按稳定资源键串行执行异步临界区
 */
export class KeyedMutex {
  /** 每个资源键最后一个排队任务的释放门闩 */
  private readonly _tails = new Map<string, Promise<void>>()

  /**
   * 独占执行指定资源的异步操作
   */
  public async runExclusive<T>(key: string, callback: () => Promisable<T>) {
    const previous = this._tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    this._tails.set(key, current)
    await previous

    try {
      return await callback()
    }
    finally {
      release()

      // 仅队尾负责清理，后续任务已经接管同一 key 时保留它的释放链
      if (this._tails.get(key) === current)
        this._tails.delete(key)
    }
  }
}
