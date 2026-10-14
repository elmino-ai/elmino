import PQueue from 'p-queue'

/** -------------------- 类型 -------------------- */
/** 进程内 Job 的当前调度状态 */
export type JobStatus = 'queued' | 'running'

/** 单个活动 Job 的取消与状态控制 */
interface JobEntry {
  /** 当前调度状态 */
  status: JobStatus
  /** 仅用于从 p-queue 移除尚未开始的 Job */
  queueController: AbortController
  /** 通知已经开始的 Job 停止 */
  executionController: AbortController
}

/** -------------------- 核心类 -------------------- */
/**
 * 按固定并发上限执行当前进程内的 Job
 */
export class JobQueue {
  /** 底层 FIFO 并发队列 */
  private readonly _queue: PQueue

  /** 已提交但尚未结束的 Job */
  private readonly _entries = new Map<string, JobEntry>()

  /** 幂等关闭任务 */
  private _closing?: Promise<void>

  /**
   * 创建固定并发上限的队列
   */
  public static create(concurrency: number) {
    return new JobQueue(concurrency)
  }

  /**
   * 创建底层 p-queue
   */
  private constructor(concurrency: number) {
    this._queue = new PQueue({ concurrency })
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 提交 Job 并在获得槽位后执行
   */
  public submit<T>(
    id: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this._closing)
      return Promise.reject(new Error('JobQueue 已经关闭'))
    if (this._entries.has(id))
      return Promise.reject(new Error(`Job 已提交: ${id}`))
    if (signal?.aborted)
      return Promise.reject(signal.reason)

    const queueController = new AbortController()
    const executionController = new AbortController()
    const entry: JobEntry = {
      status: 'queued',
      queueController,
      executionController,
    }
    /** 将调用方取消按当前阶段投影到独立 Controller */
    const abort = () => this.cancel(id, signal?.reason)

    signal?.addEventListener('abort', abort, { once: true })
    this._entries.set(id, entry)

    // p-queue 会在传入的 signal 运行期取消时提前释放槽位，因此它只接收排队 Controller
    return this._queue.add(() => {
      entry.status = 'running'
      return run(executionController.signal)
    }, {
      id,
      signal: queueController.signal,
    }).finally(() => {
      signal?.removeEventListener('abort', abort)

      if (this._entries.get(id) === entry)
        this._entries.delete(id)
    })
  }

  /**
   * 取消排队或通知运行中的 Job 停止
   */
  public cancel(id: string, reason: unknown = 'cancelled') {
    const entry = this._entries.get(id)

    if (!entry)
      return false

    if (entry.status === 'queued')
      entry.queueController.abort(reason)
    else
      entry.executionController.abort(reason)

    return true
  }

  /**
   * 读取活动 Job 的当前调度状态
   */
  public status(id: string): JobStatus | undefined {
    return this._entries.get(id)?.status
  }

  /**
   * 停止接收新 Job、中止全部活动 Job 并等待执行协程退出
   */
  public close() {
    if (this._closing)
      return this._closing

    const closing = Promise.withResolvers<void>()
    const reason = new Error('JobQueue 正在关闭')

    this._closing = closing.promise
    this._queue.pause()

    for (const id of [...this._entries.keys()])
      this.cancel(id, reason)

    this._queue.onIdle().then(closing.resolve, closing.reject)

    return this._closing
  }
}
