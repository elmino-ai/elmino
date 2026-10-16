import type { ApiTurnCreateInput, ThreadTarget } from '@elmino/api'
import type { JsonValue } from '@elmino/shared'
import type { ThreadState } from '@elmino/thread'
import type { Client } from '../client/client'
import type { EventChannels } from '../events/channel'
import type { ThreadProjection } from '../thread/projection'
import type {
  ClientInteraction,
  ClientObserveOptions,
  ClientRun,
  ClientRunResult,
  ClientThreadRunOptions,
} from './types'
import { ORPCError } from '@orpc/client'
import { createRunOutput } from './output'
import { readRunResult } from './result'

/** 客户端原始传输或同工作区共享事件通道，执行逻辑不持有连接池 */
export type RunClient = Pick<Client, 'rpc'> & {
  /** 借用共享事件连接，连接重置与本地校准拥有不同的生命周期 */
  subscribe: EventChannels['subscribe']
  /** 执行观察向所属会话发布状态，消费回调不持有另一份全局当前 Turn */
  onState?: (state: ThreadState) => void
  /** 所属会话唯一投影，运行和界面订阅不反向重置彼此的增量锚点 */
  projection: ThreadProjection
}

/** 创建、恢复和只观察共用同一生命周期，只在提交阶段选择对应操作 */
export type RunOperation
  = | { type: 'create', input: ApiTurnCreateInput['input'], options: ClientThreadRunOptions }
    | { type: 'resume', interaction: ClientInteraction, response: JsonValue }
    | { type: 'attach' }

/** 同一次远程执行的固定身份与控制权；本地观察结束不撤销远端任务 */
export class RemoteRun implements ClientRun {
  /** 任务归属的 Agent */
  public readonly agentId: string
  /** 任务归属的工作区 */
  public readonly workspaceId: string
  /** 会话身份，在提交前即可保存 */
  public readonly threadId: string
  /** 本轮身份，在提交前即可供控件捕获 */
  public readonly turnId: string
  /** 创建或恢复被服务端接纳；attach 则表示已找到既有任务 */
  public readonly accepted: Promise<void>
  /** 等待这次执行片段的终态与最终线程快照 */
  public readonly completed: Promise<ClientRunResult>
  /** 句柄独占的本地观察生命周期，detach 不触碰远端执行控制器 */
  private readonly _controller = new AbortController()
  /** 接纳确认的内部完成器，创建失败同时拒绝 accepted 等待者 */
  private readonly _acceptance = Promise.withResolvers<void>()

  /**
   * 固定运行身份并立即建立观察生命周期，公共入口统一通过工厂创建
   */
  private constructor(
    private readonly _client: RunClient,
    target: ThreadTarget & { turnId: string },
    operation: RunOperation,
    options: ClientObserveOptions,
  ) {
    this.agentId = target.agentId
    this.workspaceId = target.workspaceId
    this.threadId = target.threadId
    this.turnId = target.turnId
    this.accepted = this._acceptance.promise
    this.accepted.catch(() => undefined)
    this.completed = this._observe(operation, options)
    this.completed.catch(error => this._acceptance.reject(error))
  }

  /**
   * 创建观察句柄，生成身份由所属会话完成；共享同一段接纳、重连与结算逻辑
   */
  public static create(client: RunClient, target: ThreadTarget & { turnId: string }, operation: RunOperation, options: ClientObserveOptions): ClientRun {
    return new RemoteRun(client, target, operation, options)
  }

  /**
   * 停止准确的远端 Turn；尚在提交时先等待接纳，不会误停下一轮
   */
  public async interrupt(reason?: string): Promise<ThreadState> {
    await this.accepted
    // 控制权不随 detach 消失，返回的权威结果仍更新所属会话
    const epoch = this._client.projection.getEpoch()
    const state = await this._client.rpc.turn.interrupt({ ...this._target(), reason })
    if (epoch === this._client.projection.getEpoch()) {
      this._client.projection.merge(state)
      this._client.onState?.(this._client.projection.getSnapshot()!)
    }
    return state
  }

  /**
   * 在运行边界追加要求，不创建新 Turn、不替换正在执行的工具
   */
  public async steer(text: string) {
    await this.accepted
    return this._client.rpc.turn.steer({ ...this._target(), text })
  }

  /**
   * 结束本地等待和订阅；任务仍可通过 thread.attach(turnId) 重新观察
   */
  public detach(reason: unknown = new DOMException('已结束客户端观察', 'AbortError')): void {
    this._controller.abort(reason)
  }

  /**
   * 组合当前句柄的完整归属，所有查询和控制均命中同一个 Turn
   */
  private _target() {
    return { agentId: this.agentId, workspaceId: this.workspaceId, threadId: this.threadId, turnId: this.turnId }
  }

  /**
   * 编排订阅、一次提交、恢复基线与终态补齐，并统一清理本地资源
   */
  private async _observe(operation: RunOperation, options: ClientObserveOptions): Promise<ClientRunResult> {
    options.signal?.throwIfAborted()
    // 复用句柄的本地取消控制器，结束观察不会自动中断远端任务
    const controller = this._controller
    // 拆出精确运行身份与线程查询范围，两者始终来自同一句柄
    const { turnId, ...target } = this._target()
    // 让等待接纳、终态及 RPC 的各阶段响应同一个本地取消原因
    const failure = Promise.withResolvers<never>()
    failure.promise.catch(() => undefined)
    // 等待事件订阅完成校准，再允许创建或恢复远端任务
    const ready = Promise.withResolvers<void>()
    // 仅在确认本次执行片段终态后唤醒最终快照读取
    const ended = Promise.withResolvers<void>()
    /** 把宿主取消原因汇入当前观察控制器，不发送远端停止请求 */
    const abort = () => controller.abort(options.signal?.reason)
    /** 将本地取消原因传给所有在途等待，保留原始拒绝对象 */
    const fail = () => failure.reject(controller.signal.reason)
    controller.signal.addEventListener('abort', fail, { once: true })
    options.signal?.addEventListener('abort', abort, { once: true })
    /** 让一个异步阶段与本地取消竞速，避免等待无响应的用户回调或请求 */
    const wait = <T>(task: Promise<T>) => Promise.race([task, failure.promise])
    // 本次执行片段独占的输出去重与恢复基线，不与其他任务混用
    const output = createRunOutput(options, controller.signal)
    // 所属会话只持有一份事实投影；多个观察各自保留输出位置
    const projection = this._client.projection
    // 标记已开始提交或附着，提交前的工作区历史不得影响当前任务
    let submitted = operation.type === 'attach'
    // 区分接纳前竞态与已接纳执行，恢复终态只在正确阶段确认
    let accepted = false
    // 恢复时等待新执行开始，过滤旧运行片段的输出事实
    let started = operation.type !== 'resume'
    // 串联事实与快照投影，用户输出回调保持顺序且失败后结束当前观察
    let processing = Promise.resolve()
    /** 保存当前观察者的释放入口，所有退出路径统一退订 */
    let stop: (() => void) | undefined

    /** 串行安排状态与输出投影，失败时以原错误取消当前调用 */
    const project = (action: () => void | Promise<void>) => {
      // 回调可能等待宿主很久，执行时再次核对生命周期，不能投递删除前排队的旧结果
      const epoch = projection.getEpoch()
      processing = processing.then(() => {
        controller.signal.throwIfAborted()
        if (epoch !== projection.getEpoch())
          throw new ORPCError('NOT_FOUND', { message: '会话已删除，排队投影已失效' })
        return action()
      })
      processing.catch(error => controller.abort(error))
      return processing
    }
    /** 普通读取保留流式锚点，删除前发起的迟到读取不得复活会话 */
    const read = async () => {
      const epoch = projection.getEpoch()
      const state = await this._client.rpc.thread.get(target, { signal: controller.signal })
      controller.signal.throwIfAborted()
      if (epoch !== projection.getEpoch())
        throw new ORPCError('NOT_FOUND', { message: '会话已删除，先前读取已失效' })
      projection.merge(state)
      this._client.onState?.(projection.getSnapshot()!)
      return state
    }
    /** 只根据指定 Turn 的权威终态结束观察，恢复前的原审批保持等待 */
    const observe = (state: ThreadState) => {
      // 权威状态已离开原中断时，漏掉 turn.started 也能继续恢复后的流式输出
      if (operation.type === 'resume' && state.runtime.turnId === turnId
        && state.runtime.status === 'running'
        && state.runtime.interrupt?.id !== operation.interaction.interruptId) {
        started = true
      }
      // 将当前权威线程快照投影成本轮结果，其他运行不影响结束判定
      const result = readRunResult(this._target(), state)
      if (!result)
        return
      // resume 仍使用原 Turn；旧审批中断不代表新执行片段已经结束
      if (operation.type === 'resume' && result.interaction?.interruptId === operation.interaction.interruptId)
        return
      ended.resolve()
    }
    try {
      stop = this._client.subscribe({ agentId: target.agentId, workspaceId: target.workspaceId }, {
        /** 订阅完成校准后解除提交门禁，重连不再次提交任务 */
        onConnected: () => ready.resolve(),
        /** 确定性客户端错误结束当前调用，临时断线留给订阅重连 */
        onError: (error) => {
          if (error instanceof ORPCError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
            controller.abort(error)
        },
        /** 连接历史不可用时重建本轮输出与终态，未提交的新线程允许暂不存在 */
        onReset: async (connection) => {
          // 仅真实传输重置结束旧基线；新 attach 与过载校准不能清除其他观察者的锚点
          projection.resetConnection(connection)
          if (!submitted)
            return
          // 保存重连查询或创建、恢复接纳返回的权威线程状态
          let state: ThreadState
          try {
            state = await read()
          }
          catch (error) {
            if (operation.type === 'create' && !accepted && error instanceof ORPCError && error.code === 'NOT_FOUND')
              return
            throw error
          }
          await project(async () => {
            await output.snapshot(state, turnId)
            observe(state)
          })
        },
        /** 串行投影本线程本轮事实，恢复终态还需权威快照排除历史事件 */
        onEvent: async (event) => {
          if (!submitted || event.threadId !== target.threadId || event.turnId !== turnId)
            return
          if (operation.type === 'resume' && event.type === 'turn.interrupted' && event.interruptId === operation.interaction.interruptId)
            return
          if (operation.type === 'resume' && event.createdAt < operation.interaction.interrupt.createdAt)
            return
          if (event.type === 'turn.started')
            started = true
          // 原恢复片段尚未开始时，不交付旧内容；终态仍要读权威状态核对
          const terminal = ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.type)
          if (!started && !terminal)
            return
          // 流式正文共用会话投影；Step 等事实不逐项查询，终态和消息缺口才校准
          const projected = projection.apply(event)
          let state = projected.state
          if (projected.refresh && (event.type.startsWith('message.') || !state || terminal)) {
            // 请求失败交给共享通道重连重置，不把临时网络错误当成输出回调失败
            state = await read()
            projection.merge(state)
          }
          await project(async () => {
            if (state) {
              this._client.onState?.(projection.getSnapshot() ?? state)
              await output.snapshot(state, turnId)
            }
            // 每个观察者独立消费事件；其他观察者的慢回调不阻塞本轮执行
            await options.onEvent?.(event)
            if (terminal) {
              if (operation.type === 'resume') {
                if (accepted && state)
                  observe(state)
              }
              else {
                ended.resolve()
              }
            }
          })
        },
      })
      await wait(ready.promise)
      // 保存重连查询或创建、恢复接纳返回的权威线程状态
      let state: ThreadState
      // 接纳响应也可能晚于删除事实，不允许旧 HTTP 响应复活已清空的会话
      const epoch = projection.getEpoch()
      if (operation.type === 'resume') {
        // 恢复前的原运行输出快照，作为已展示基线以免重新打印旧内容
        const baseline = await wait(read())
        projection.merge(baseline)
        await wait(project(() => output.seed(baseline, turnId)))
        submitted = true
        state = await wait(this._client.rpc.turn.resume({
          ...target,
          turnId,
          interruptId: operation.interaction.interruptId,
          response: operation.response,
        }, { signal: controller.signal }))
      }
      else if (operation.type === 'create') {
        submitted = true
        // 仅提取新建运行允许覆盖的策略，恢复不读取这些参数
        const { modelId, approvalMode, subagentMode } = operation.options
        state = await wait(this._client.rpc.turn.create({ ...target, turnId, input: operation.input, modelId, approvalMode, subagentMode }, { signal: controller.signal }))
      }
      else {
        state = await wait(read())
        if (!state.turns.some(turn => turn.id === turnId))
          throw new ORPCError('NOT_FOUND', { message: '运行不存在' })
        await wait(project(() => output.snapshot(state, turnId)))
      }
      if (epoch !== projection.getEpoch())
        throw new ORPCError('NOT_FOUND', { message: '会话已删除，接纳响应已失效' })
      projection.merge(state)
      this._client.onState?.(state)
      accepted = true
      this._acceptance.resolve()
      if (operation.type === 'resume') {
        // 新终态可能先于接纳响应到达；这里读一次当前状态，补齐这个竞态窗口
        state = await wait(read())
        projection.merge(state)
        this._client.onState?.(projection.getSnapshot()!)
        await wait(project(() => output.snapshot(state, turnId)))
      }
      observe(state)
      await wait(ended.promise)
      stop()
      await wait(processing)
      // 终态后读取的完整权威快照，用来补齐缺失输出并形成最终结果
      const thread = await wait(read())
      this._client.onState?.(thread)
      await wait(project(() => output.snapshot(thread, turnId)))
      // 将当前权威线程快照投影成本轮结果，其他运行不影响结束判定
      const result = readRunResult(this._target(), thread)
      if (!result)
        throw new Error('远程执行结束后缺少对应的终态记录')
      return result
    }
    finally {
      stop?.()
      options.signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', fail)
      controller.abort()
    }
  }
}
