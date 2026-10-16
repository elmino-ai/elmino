import type { JsonValue } from '@elmino/shared'
import type { ThreadState } from '@elmino/thread'
import type { ToolApprovalDecision } from '@elmino/tool'
import type { RunClient } from '../run/run'
import type {
  ClientInteraction,
  ClientObserveOptions,
  ClientRun,
  ClientRunOptions,
  ClientRunResult,
  ClientThreadRunOptions,
} from '../run/types'
import type { ClientThread, ClientThreadOptions, ClientThreadSnapshot } from './types'
import type { ThreadWatchOptions } from './watch'
import { createId } from '@elmino/shared'
import { readToolApprovalPayload, readToolApprovalResponse } from '@elmino/tool'
import { ORPCError } from '@orpc/client'
import { readRunResult } from '../run/result'
import { RemoteRun } from '../run/run'
import { ThreadProjection } from './projection'
import { watchThread } from './watch'

/** 固定会话身份，保持模型与执行资源在远端；不持有全局当前 Turn */
export class ThreadClient implements ClientThread {
  /** 已注册的 Agent */
  public readonly agentId: string
  /** 服务端工作区 */
  public readonly workspaceId: string
  /** 后续调用沿用的会话身份 */
  public readonly threadId: string

  /** 会话内唯一的事实投影，运行回调与前端消费共用合并规则 */
  private readonly _projection = ThreadProjection.create()
  /** 外部 Store 所需的稳定快照，读取不会新建对象 */
  private _snapshot: ClientThreadSnapshot = { status: 'idle' }
  /** 当前句柄的轻量状态观察者，最后一个退出才释放连接 */
  private readonly _listeners = new Set<() => void>()
  /** 有界批量通知定时器，逐字事件不逐次触发界面重算 */
  private _timer: ReturnType<typeof setTimeout> | undefined
  /** 当前状态观察占用的共享工作区通道引用 */
  private _stop: (() => void) | undefined
  /** 异步观察也属于当前会话连接，最后退出时才能标记本地关闭 */
  private _watchers = 0

  /**
   * 固定会话归属并保留共享客户端，构造本地句柄不创建服务端记录
   */
  private constructor(private readonly _client: Pick<RunClient, 'rpc' | 'subscribe'>, options: ClientThreadOptions) {
    this.agentId = options.agentId
    this.workspaceId = options.workspaceId
    this.threadId = options.threadId ?? createId('thread')
  }

  /**
   * 只绑定身份，不隐式创建服务端空会话
   */
  public static create(client: Pick<RunClient, 'rpc' | 'subscribe'>, options: ClientThreadOptions): ClientThread {
    return new ThreadClient(client, options)
  }

  /**
   * 发送新一轮并等待结果，连续调用自动使用同一会话
   */
  public run(input: ClientRunOptions['input'], options: ClientThreadRunOptions = {}): Promise<ClientRunResult> {
    return this.start(input, options).completed
  }

  /**
   * 立即返回有固定身份的执行句柄，界面可以在执行完成前停止或引导
   */
  public start(input: ClientRunOptions['input'], options: ClientThreadRunOptions = {}): ClientRun {
    // 绑定本次新建或取消的精确运行身份，控制操作不追随其他 Turn
    const target = { ...this._target(), turnId: options.turnId ?? createId('turn') }
    // 把简洁文本转换成 API 内容数组，保留已结构化附件输入
    const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input
    return RemoteRun.create(this._runClient(), target, { type: 'create', input: parts, options }, options)
  }

  /**
   * 刷新页面后重新观察原运行，不提交新的任务
   */
  public attach(turnId: string, options: ClientObserveOptions = {}): ClientRun {
    return RemoteRun.create(this._runClient(), { ...this._target(), turnId }, { type: 'attach' }, options)
  }

  /**
   * 读取完整历史；未首次运行的本地会话仍可能收到 NOT_FOUND
   */
  public async get(options: { signal?: AbortSignal } = {}): Promise<ThreadState> {
    // 只有成功读取后才更新投影，取消或请求失败不会清除已有历史
    const epoch = this._projection.getEpoch()
    const state = await this._client.rpc.thread.get(this._target(), options)
    options.signal?.throwIfAborted()
    if (epoch !== this._projection.getEpoch())
      throw new ORPCError('NOT_FOUND', { message: '会话已删除，先前读取已失效' })
    this._acceptState(state)
    return this._snapshot.thread!
  }

  /**
   * 读取持久化运行摘要，包含刷新后可诊断的失败原因
   */
  public listTurns(options: { signal?: AbortSignal } = {}): ReturnType<RunClient['rpc']['thread']['listTurns']> {
    return this._client.rpc.thread.listTurns(this._target(), options)
  }

  /**
   * 按完整 Turn 分页读取更早历史，不把局部页覆盖实时完整快照
   */
  public readTranscript(input: Parameters<ClientThread['readTranscript']>[0] = {}, options: { signal?: AbortSignal } = {}): ReturnType<RunClient['rpc']['thread']['readTranscript']> {
    return this._client.rpc.thread.readTranscript({ ...this._target(), ...input }, options)
  }

  /**
   * 返回稳定引用，适用于 useSyncExternalStore 与框架外订阅
   */
  public getSnapshot(): ClientThreadSnapshot {
    return this._snapshot
  }

  /**
   * 首个观察者建立连接，最后退订时关闭该句柄持有的本地资源
   */
  public subscribe(listener: () => void): () => void {
    /** 每次订阅拥有独立引用，同一函数可以同时由多个消费者注册 */
    const notify = () => listener()
    this._listeners.add(notify)
    if (!this._stop) {
      this._publish({ ...this._snapshot, status: 'connecting', error: undefined })
      this._stop = watchThread(this._client, this._client.subscribe, this._target(), state => this._acceptState(state), {
        /** 断线保留已展示内容，等待通道校准后恢复 */
        onError: error => this._publish({ ...this._snapshot, status: 'reconnecting', error }),
        /** 连接状态与远端 Turn 状态分别拥有各自语义 */
        onStatus: status => this._publish({ ...this._snapshot, status, error: undefined }),
        /** 删除不能留下可被界面继续操作的旧线程 */
        onMissing: () => this._publish({ ...this._snapshot, thread: undefined }),
      }, this._projection)
    }
    // 单个订阅只释放自己的引用，重复退订不影响其他消费者
    let released = false
    /** 只移除当前监听器，最后一个监听器负责归还观察资源 */
    return () => {
      if (released)
        return
      released = true
      this._listeners.delete(notify)
      if (this._listeners.size === 0) {
        this._stop?.()
        this._stop = undefined
        this._closeIfIdle()
      }
    }
  }

  /**
   * 先读取状态，再跟随实时变化与重连校准；返回值只释放当前观察者
   */
  public watch(listener: (state: ThreadState) => void | Promise<void>, options: ThreadWatchOptions = {}): () => void {
    if (options.signal?.aborted)
      return () => undefined
    this._watchers += 1
    if (!this._stop && this._watchers === 1)
      this._publish({ ...this._snapshot, status: 'connecting', error: undefined })
    // 异步观察持有独立通道引用，其取消不能关闭其他状态观察者
    let stop: (() => void) | undefined
    let released = false
    /** 信号与手动退订共用释放入口，连接引用和状态只结算一次 */
    const release = () => {
      if (released)
        return
      released = true
      options.signal?.removeEventListener('abort', release)
      stop?.()
      this._watchers -= 1
      this._closeIfIdle()
    }
    options.signal?.addEventListener('abort', release, { once: true })
    try {
      stop = watchThread(this._client, this._client.subscribe, this._target(), (state) => {
        this._acceptState(state)
        return listener(state)
      }, {
        ...options,
        /** 异步消费也更新同一状态所有者，删除不能残留在同步快照中 */
        onMissing: () => this._publish({ ...this._snapshot, thread: undefined }),
        /** 校准成功与失败共用句柄的连接状态，界面不额外推断 */
        onStatus: status => this._publish({ ...this._snapshot, status, error: undefined }),
        /** 保留原错误报告，同时把本地观察失败交给同步快照消费者 */
        onError: async (error) => {
          this._publish({ ...this._snapshot, status: 'reconnecting', error })
          await options.onError?.(error)
        },
      }, this._projection)
      if (released)
        stop()
    }
    catch (error) {
      release()
      throw error
    }
    return release
  }

  /**
   * 通用交互恢复，沿用原 Turn 与冻结配置；恢复前内容不会再次输出
   */
  public resume(interaction: ClientInteraction, response: JsonValue, options: ClientObserveOptions = {}): ClientRun {
    this._assertInteraction(interaction)
    return RemoteRun.create(this._runClient(), { ...this._target(), turnId: interaction.turnId }, { type: 'resume', interaction, response }, options)
  }

  /**
   * 明确批准当前整批工具；逐项做不同决定时使用 respond
   */
  public approve(interaction: ClientInteraction, options: ClientObserveOptions = {}): ClientRun {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    return this.respond(interaction, payload.actionRequests.map(action => ({ type: 'approve', callId: action.callId })), options)
  }

  /**
   * 明确拒绝当前整批工具，模型随后仍可继续解释或采用其他办法
   */
  public reject(interaction: ClientInteraction, message?: string, options: ClientObserveOptions = {}): ClientRun {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    return this.respond(interaction, payload.actionRequests.map(action => ({ type: 'reject', callId: action.callId, ...(message === undefined ? {} : { message }) })), options)
  }

  /**
   * 完整提交本批 approve、reject、edit 或 respond 决策，必须覆盖每个请求
   */
  public respond(interaction: ClientInteraction, decisions: ToolApprovalDecision[], options: ClientObserveOptions = {}): ClientRun {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    // 校验后的整批人工决策，必须完整覆盖当前工具请求
    const response = readToolApprovalResponse({ decisions } as JsonValue, payload)
    if (!response)
      throw new TypeError('审批决策必须完整匹配当前请求与允许的操作')
    return this.resume(interaction, response as unknown as JsonValue, options)
  }

  /**
   * 取消准确的待交互任务；与拒绝工具后继续模型推理不同
   */
  public async cancel(interaction: ClientInteraction, reason?: string, options: { signal?: AbortSignal } = {}): Promise<ClientRunResult> {
    this._assertInteraction(interaction)
    // 绑定本次新建或取消的精确运行身份，控制操作不追随其他 Turn
    const target = { ...this._target(), turnId: interaction.turnId }
    // 取消事务晚于会话删除时，仅返回请求结果，不让旧快照重新进入本地状态
    const epoch = this._projection.getEpoch()
    // Server 完成取消事务后返回的权威线程状态
    const state = await this._client.rpc.turn.cancel({ ...target, interruptId: interaction.interruptId, reason }, options)
    options.signal?.throwIfAborted()
    if (epoch === this._projection.getEpoch())
      this._acceptState(state)
    // 等待本次恢复或取消操作完成后的结果，不另建会话或执行器
    const result = readRunResult(target, state)
    if (!result)
      throw new Error('取消任务后缺少对应的终态记录')
    return result
  }

  /**
   * 将执行观察的权威状态交回所属会话，不暴露内部工厂依赖
   */
  private _runClient(): RunClient {
    return { rpc: this._client.rpc, subscribe: this._client.subscribe, projection: this._projection, onState: state => this._acceptState(state) }
  }

  /**
   * 合并读取或执行结果，语义未变时不触发新的界面快照
   */
  private _acceptState(state: ThreadState) {
    // 投影已经由当前 watch 更新时无需清除流式锚点
    const thread = state === this._projection.getSnapshot() ? state : this._projection.merge(state)
    if (thread !== this._snapshot.thread)
      this._publish({ ...this._snapshot, thread })
  }

  /**
   * 所有状态观察者离开后关闭本地观察状态，保留最后已展示的会话内容
   */
  private _closeIfIdle() {
    if (this._listeners.size > 0 || this._watchers > 0)
      return
    if (this._timer !== undefined)
      clearTimeout(this._timer)
    this._timer = undefined
    this._snapshot = { ...this._snapshot, status: 'closed' }
  }

  /**
   * 合并一帧内的通知，释放后不再调用已卸载的消费者
   */
  private _publish(snapshot: ClientThreadSnapshot) {
    if (snapshot.thread === this._snapshot.thread && snapshot.status === this._snapshot.status && snapshot.error === this._snapshot.error)
      return
    this._snapshot = snapshot
    if (this._listeners.size === 0 || this._timer !== undefined)
      return
    this._timer = setTimeout(() => {
      this._timer = undefined
      // 监听器失败只记录本地错误，不阻止其他消费者读取同一快照
      for (const listener of this._listeners) {
        try {
          listener()
        }
        catch (error) {
          this._snapshot = { ...this._snapshot, error }
        }
      }
    }, 16)
  }

  /**
   * 返回会话归属供读取与执行复用，不持有可漂移的当前 Turn
   */
  private _target() {
    return { agentId: this.agentId, workspaceId: this.workspaceId, threadId: this.threadId }
  }

  /**
   * 确认交互句柄属于本会话，防止审批或取消误作用于其他任务
   */
  private _assertInteraction(interaction: ClientInteraction) {
    if (interaction.agentId !== this.agentId || interaction.workspaceId !== this.workspaceId || interaction.threadId !== this.threadId)
      throw new TypeError('交互不属于当前会话')
    if (interaction.interruptId !== interaction.interrupt.id || interaction.turnId !== interaction.interrupt.turnId)
      throw new TypeError('交互身份与中断快照不一致')
  }

  /**
   * 校验会话归属并读取内置工具审批载荷，其他交互走通用恢复入口
   */
  private _approval(interaction: ClientInteraction) {
    this._assertInteraction(interaction)
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = readToolApprovalPayload(interaction.interrupt)
    if (!payload)
      throw new TypeError('当前交互不是工具审批')
    return payload
  }
}
