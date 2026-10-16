import type { ThreadInputContent } from '@elmino/thread'
import type { ClientRun } from '../run/types'
import type {
  ComposerInput,
  ComposerOptions,
  ComposerQueuedInput,
  ComposerRunOptions,
  ComposerSnapshot,
  ComposerSubmitBlockedReason,
  ComposerSubmitResult,
} from './types'
import { createId } from '@elmino/shared'

/**
 * 为一个固定会话管理草稿与本地队列，执行和消息始终由 ClientThread 拥有
 */
export class Composer {
  /** 当前实例借用的会话，不取得远端执行资源的关闭权 */
  public readonly thread: ComposerOptions['thread']
  /** 公开快照只在可观察字段变化后替换 */
  private _snapshot: ComposerSnapshot
  /** 当前 Composer 的状态观察者 */
  private readonly _listeners = new Set<() => void>()
  /** 草稿和队列借用的唯一会话订阅 */
  private _unsubscribe?: () => void
  /** 接纳与完成之间仍由当前 Composer 跟随的运行 */
  private _run?: ClientRun
  /** 关闭后禁止继续调度队列 */
  private _disposed = false

  /**
   * 创建固定绑定当前会话的 Composer，构造阶段不建立网络连接
   */
  public static create(options: ComposerOptions): Composer {
    return new Composer(options)
  }

  /**
   * 保存借用会话并隔离调用方传入的初始草稿
   */
  private constructor(options: ComposerOptions) {
    this.thread = options.thread
    this._snapshot = { input: [], queue: [], submitting: false, canSubmit: false }
    this.setInput(options.input ?? [])
  }

  /**
   * 返回稳定快照，读取本身不会启动观察或发送请求
   */
  public getSnapshot = (): ComposerSnapshot => this._snapshot

  /**
   * 订阅草稿与队列，最后一个观察者离开后只保留未完成队列需要的订阅
   */
  public subscribe = (listener: () => void): (() => void) => {
    if (this._disposed)
      return () => undefined
    this._listeners.add(listener)
    this._observe()
    /** 释放当前观察者，不停止已接纳的远端任务 */
    return () => {
      this._listeners.delete(listener)
      this._observe()
    }
  }

  /**
   * 替换当前草稿，结构化附件与引用沿用已有领域输入契约
   */
  public setInput(input: ComposerInput): void {
    if (this._disposed)
      return
    // 草稿与调用方数组隔离，发送期间的新草稿拥有不同引用
    const parts: ThreadInputContent[] = typeof input === 'string'
      ? input ? [{ type: 'text', text: input }] : []
      : structuredClone([...input])
    this._publish({ input: parts, error: undefined })
  }

  /**
   * 发送当前草稿或加入队列，只有服务端接纳后才消费原草稿
   */
  public async submit(options: ComposerRunOptions = {}): Promise<ComposerSubmitResult> {
    // 提交校验只保护非空、准确交互与本地发送互斥，不重复解析 HTTP Schema
    const reason = this._blocked()
    if (reason)
      return { status: 'blocked', reason }
    // 固定本次正文，迟到接纳不能清空用户后来输入的内容
    const input = this._snapshot.input
    // 每个队列项保存提交当时的策略，不在真正发送时读取其他调用的选项
    const frozenOptions = { ...options }
    if (this._run || this._running() || this._snapshot.queue.length > 0) {
      // 队列身份只用于本地编辑与排序，不替代远端 Turn 身份
      const item: ComposerQueuedInput = {
        id: createId('queue'),
        input,
        options: frozenOptions,
        paused: false,
      }
      this._publish({ input: [], queue: [...this._snapshot.queue, item], error: undefined })
      this._observe()
      this._schedule()
      return { status: 'queued', item }
    }
    // 立即提交仍返回原运行句柄，Composer 不维护第二套完成状态
    const run = await this._send(input, frozenOptions)
    return { status: 'submitted', run }
  }

  /**
   * 删除尚未发出的队列项，正在确认接纳的项保持原身份等待结果
   */
  public removeQueuedInput(id: string): void {
    if (this._snapshot.submitting || this._disposed)
      return
    this._publish({ queue: this._snapshot.queue.filter(item => item.id !== id) })
    this._observe()
    this._schedule()
  }

  /**
   * 按当前展示索引移动尚未提交的队列项
   */
  public moveQueuedInput(from: number, to: number): void {
    if (this._snapshot.submitting || this._disposed || from === to
      || !Number.isInteger(from) || !Number.isInteger(to)
      || from < 0 || to < 0 || from >= this._snapshot.queue.length || to >= this._snapshot.queue.length) {
      return
    }
    // 只调整本地顺序，已接纳运行不受队列排序影响
    const queue = [...this._snapshot.queue]
    // 范围检查保证待移动项存在
    const [item] = queue.splice(from, 1)
    queue.splice(to, 0, item!)
    this._publish({ queue })
    this._schedule()
  }

  /**
   * 将指定队列项移回草稿，未知接纳结果只能由用户明确重新提交
   */
  public editQueuedInput(id: string): void {
    if (this._snapshot.submitting || this._disposed)
      return
    // 按稳定身份找到原输入，不依赖可能已变更的展示索引
    const item = this._snapshot.queue.find(item => item.id === id)
    if (!item)
      return
    this._publish({ input: item.input, queue: this._snapshot.queue.filter(item => item.id !== id), error: undefined })
    this._observe()
    this._schedule()
  }

  /**
   * 释放本地订阅和队列调度，不中断或关闭借用会话上的远端任务
   */
  public dispose(): void {
    if (this._disposed)
      return
    this._disposed = true
    this._unsubscribe?.()
    this._unsubscribe = undefined
    this._publish({ canSubmit: false })
    this._listeners.clear()
  }

  /**
   * 从唯一会话快照判断是否仍有排队或运行中的 Turn
   */
  private _running(): boolean {
    // 运行事实由会话维护，连接状态本身不等于任务运行状态
    const thread = this.thread.getSnapshot().thread
    return thread?.runtime.status === 'running'
      || thread?.turns.some(turn => turn.status === 'queued' || turn.status === 'running') === true
  }

  /**
   * 判断当前草稿的提交边界，运行中允许排队但待交互时不能另发任务
   */
  private _blocked(): ComposerSubmitBlockedReason | undefined {
    if (this._disposed || this.thread.getSnapshot().status === 'closed')
      return 'closed'
    if (this._snapshot.submitting)
      return 'submitting'
    if (!this._snapshot.input.some(part => part.type !== 'text' || part.text.trim().length > 0))
      return 'empty'
    // 交互中断只能恢复原 Turn，不能由队列绕过审批继续创建任务
    const interrupt = this.thread.getSnapshot().thread?.runtime.interrupt
    if (interrupt?.kind === 'interaction' && interrupt.status === 'pending')
      return 'pendingInteraction'
    return undefined
  }

  /**
   * 发布本地输入状态，会话消息与终态不进入 Composer 快照
   */
  private _publish(patch: Partial<ComposerSnapshot> = {}): void {
    // 先更新草稿字段，再从最新会话和草稿计算提交能力
    const previous = this._snapshot
    this._snapshot = { ...previous, ...patch }
    this._snapshot = { ...this._snapshot, canSubmit: this._blocked() === undefined }
    if (Object.keys(this._snapshot).every(key => Object.is(
      previous[key as keyof ComposerSnapshot],
      this._snapshot[key as keyof ComposerSnapshot],
    ))) {
      this._snapshot = previous
      return
    }
    // 观察者失败不改变接纳事实，也不阻止其他视图读取已经发布的草稿
    for (const listener of [...this._listeners]) {
      try {
        listener()
      }
      catch (error) {
        this._snapshot = { ...this._snapshot, error }
      }
    }
  }

  /**
   * 按视图与队列实际需要持有一个会话订阅，构造与快照读取没有副作用
   */
  private _observe(): void {
    if (!this._disposed && (this._listeners.size > 0 || this._snapshot.queue[0]?.paused === false)) {
      if (!this._unsubscribe) {
        // 订阅可能同步发布连接状态，先占位避免重入重复取得订阅
        this._unsubscribe = () => undefined
        // 注册过程中视图也可能离开或关闭 Composer，真实释放函数返回后重新核对所有权
        const unsubscribe = this.thread.subscribe(() => {
          this._publish()
          this._schedule()
        })
        if (this._disposed || (this._listeners.size === 0 && this._snapshot.queue[0]?.paused !== false)) {
          unsubscribe()
          this._unsubscribe = undefined
          return
        }
        this._unsubscribe = unsubscribe
        // 借用已连接会话时不一定收到初始事件，立即校准提交能力
        this._publish()
      }
    }
    else {
      this._unsubscribe?.()
      this._unsubscribe = undefined
    }
  }

  /**
   * 等待当前输入接纳，并以原运行完成事实推进后续本地队列
   */
  private async _send(
    input: readonly ThreadInputContent[],
    options: ComposerRunOptions,
    queuedId?: string,
  ): Promise<ClientRun> {
    this._publish({ submitting: true, error: undefined })
    try {
      // 同步观察者可在提交提示期间关闭 Composer，关闭后的动作不能再发往远端
      if (this._disposed)
        throw new Error('Composer 已关闭')
      // 发送前冻结的输入只复制到已存在的会话执行入口
      const run = this.thread.start([...input], options)
      this._run = run
      // 完成监听只驱动后续队列，权威终态继续由运行和会话提供
      run.completed.then(
        (result) => {
          if (this._run !== run)
            return
          this._run = undefined
          if (result.status !== 'completed')
            this._pauseQueue()
          this._schedule()
        },
        (error) => {
          if (this._run !== run)
            return
          this._run = undefined
          this._pauseQueue()
          this._publish({ error })
        },
      )
      await run.accepted
      if (queuedId)
        this._publish({ queue: this._snapshot.queue.filter(item => item.id !== queuedId) })
      else if (this._snapshot.input === input)
        this._publish({ input: [] })
      return run
    }
    catch (error) {
      this._publish({ error })
      throw error
    }
    finally {
      this._publish({ submitting: false })
      this._observe()
      this._schedule()
    }
  }

  /**
   * 异常终态暂停剩余输入，避免停止任务后立即自动开始下一轮
   */
  private _pauseQueue(): void {
    if (this._snapshot.queue.some(item => !item.paused))
      this._publish({ queue: this._snapshot.queue.map(item => item.paused ? item : { ...item, paused: true }) })
    // 暂停项等待用户处理，没有视图时无需继续持有会话连接
    this._observe()
  }

  /**
   * 在已校准且空闲的会话上提交一个队首，不重试接纳结果未知的输入
   */
  private _schedule(): void {
    // 尚在重连时不能用旧快照判断空闲；正常提交的运行也必须先完成
    if (this._disposed || this._snapshot.submitting || this._run || this._running()
      || this.thread.getSnapshot().status !== 'connected') {
      return
    }
    // 快照中的待交互中断始终优先于本地队列
    const interrupt = this.thread.getSnapshot().thread?.runtime.interrupt
    if (interrupt?.kind === 'interaction' && interrupt.status === 'pending')
      return
    // 队首已尝试提交时保持暂停，不跳过它发送后续输入
    const item = this._snapshot.queue[0]
    if (!item || item.paused)
      return
    this._publish({
      queue: this._snapshot.queue.map(entry => entry.id === item.id ? { ...entry, paused: true } : entry),
      submitting: true,
    })
    // 后台队列错误记录到 Composer 快照，调用方通过订阅取得错误
    this._send(item.input, item.options, item.id).catch(error => this._publish({ error }))
  }
}
