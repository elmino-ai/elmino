import type { ApiTurnCreateInput, ThreadTarget } from '@elmino/api'
import type { JsonValue } from '@elmino/shared'
import type { ThreadState } from '@elmino/thread'
import type { Client } from '../client/client'
import type { ClientInteraction, ClientObserveOptions, ClientRunResult, ClientThreadRunOptions } from './types'
import { ORPCError } from '@orpc/client'
import { createRunOutput } from './output'
import { readRunResult } from './result'

/** 客户端原始传输或同工作区共享事件通道，执行逻辑不持有连接池 */
export type RunClient = Pick<Client, 'rpc' | 'subscribe'>

/** 创建、恢复和只观察共用同一生命周期，只在提交阶段选择对应操作 */
export type RunOperation
  = | { type: 'create', input: ApiTurnCreateInput['input'], options: ClientThreadRunOptions }
    | { type: 'resume', interaction: ClientInteraction, response: JsonValue }
    | { type: 'attach' }

/** 同一次远程执行的固定身份与控制权；本地观察结束不撤销远端任务 */
export class ClientRun {
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
    /** 共享事件与 RPC 能力，执行句柄不拥有底层整个客户端 */
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
    return new ClientRun(client, target, operation, options)
  }

  /**
   * 停止准确的远端 Turn；尚在提交时先等待接纳，不会误停下一轮
   */
  public async interrupt(reason?: string): Promise<ThreadState> {
    await this.accepted
    return this._client.rpc.turn.interrupt({ ...this._target(), reason })
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
      processing = processing.then(action)
      processing.catch(error => controller.abort(error))
      return processing
    }
    /** 只根据指定 Turn 的权威终态结束观察，恢复前的原审批保持等待 */
    const observe = (state: ThreadState) => {
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
        onReset: async () => {
          output.reset()
          if (!submitted)
            return
          // 保存重连查询或创建、恢复接纳返回的权威线程状态
          let state: ThreadState
          try {
            state = await this._client.rpc.thread.get(target, { signal: controller.signal })
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
        onEvent: event => project(async () => {
          if (!submitted || event.threadId !== target.threadId || event.turnId !== turnId)
            return
          if (operation.type === 'resume' && event.type === 'turn.interrupted' && event.interruptId === operation.interaction.interruptId)
            return
          if (operation.type === 'resume' && event.createdAt < operation.interaction.interrupt.createdAt)
            return
          if (event.type === 'turn.started')
            started = true
          // 判断当前事实是否为运行终态，恢复场景仍需读取权威状态确认
          const terminal = ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.type)
          if (started || terminal)
            await output.event(event)
          if (terminal) {
            if (operation.type === 'resume') {
              // 同一 Turn 可能多次中断；历史终态不能直接结束当前恢复片段
              if (accepted) {
                // 终态事实触发的最新线程快照，用来排除历史中断事件
                const current = await this._client.rpc.thread.get(target, { signal: controller.signal })
                await output.snapshot(current, turnId)
                observe(current)
              }
            }
            else {
              ended.resolve()
            }
          }
        }),
      })
      await wait(ready.promise)
      // 保存重连查询或创建、恢复接纳返回的权威线程状态
      let state: ThreadState
      if (operation.type === 'resume') {
        // 恢复前的原运行输出快照，作为已展示基线以免重新打印旧内容
        const baseline = await wait(this._client.rpc.thread.get(target, { signal: controller.signal }))
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
        state = await wait(this._client.rpc.thread.get(target, { signal: controller.signal }))
        if (!state.turns.some(turn => turn.id === turnId))
          throw new ORPCError('NOT_FOUND', { message: '运行不存在' })
        await wait(project(() => output.snapshot(state, turnId)))
      }
      accepted = true
      this._acceptance.resolve()
      if (operation.type === 'resume') {
        // 新终态可能先于接纳响应到达；这里读一次当前状态，补齐这个竞态窗口
        state = await wait(this._client.rpc.thread.get(target, { signal: controller.signal }))
        await wait(project(() => output.snapshot(state, turnId)))
      }
      observe(state)
      await wait(ended.promise)
      stop()
      await wait(processing)
      // 终态后读取的完整权威快照，用来补齐缺失输出并形成最终结果
      const thread = await wait(this._client.rpc.thread.get(target, { signal: controller.signal }))
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
