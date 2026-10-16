import type { JsonValue } from '@elmino/shared'
import type { ThreadState } from '@elmino/thread'
import type { ToolApprovalDecision } from '@elmino/tool'
import type { RunClient } from '../run/run'
import type {
  ClientInteraction,
  ClientObserveOptions,
  ClientRunOptions,
  ClientRunResult,
  ClientThreadRunOptions,
} from '../run/types'
import type { ClientThreadOptions } from './types'
import type { ThreadWatchOptions } from './watch'
import { createId } from '@elmino/shared'
import { readToolApprovalPayload, readToolApprovalResponse } from '@elmino/tool'
import { readRunResult } from '../run/result'
import { ClientRun } from '../run/run'
import { watchThread } from './watch'

/** 固定会话身份，保持模型与执行资源在远端；不持有全局当前 Turn */
export class ClientThread {
  /** 已注册的 Agent */
  public readonly agentId: string
  /** 服务端工作区 */
  public readonly workspaceId: string
  /** 后续调用沿用的会话身份 */
  public readonly threadId: string

  /**
   * 固定会话归属并保留共享客户端，构造本地句柄不创建服务端记录
   */
  private constructor(private readonly _client: RunClient, options: ClientThreadOptions) {
    this.agentId = options.agentId
    this.workspaceId = options.workspaceId
    this.threadId = options.threadId ?? createId('thread')
  }

  /**
   * 只绑定身份，不隐式创建服务端空会话
   */
  public static create(client: RunClient, options: ClientThreadOptions): ClientThread {
    return new ClientThread(client, options)
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
    return ClientRun.create(this._client, target, { type: 'create', input: parts, options }, options)
  }

  /**
   * 刷新页面后重新观察原运行，不提交新的任务
   */
  public attach(turnId: string, options: ClientObserveOptions = {}): ClientRun {
    return ClientRun.create(this._client, { ...this._target(), turnId }, { type: 'attach' }, options)
  }

  /**
   * 读取完整历史；未首次运行的本地会话仍可能收到 NOT_FOUND
   */
  public get(options: { signal?: AbortSignal } = {}): Promise<ThreadState> {
    return this._client.rpc.thread.get(this._target(), options)
  }

  /**
   * 先读取状态，再跟随实时变化与重连校准；返回值只释放当前观察者
   */
  public watch(listener: (state: ThreadState) => void | Promise<void>, options: ThreadWatchOptions = {}): () => void {
    return watchThread(this._client, this._client.subscribe, this._target(), listener, options)
  }

  /**
   * 通用交互恢复，沿用原 Turn 与冻结配置；恢复前内容不会再次输出
   */
  public async resume(interaction: ClientInteraction, response: JsonValue, options: ClientObserveOptions = {}): Promise<ClientRunResult> {
    this._assertInteraction(interaction)
    // 等待本次恢复或取消操作完成后的结果，不另建会话或执行器
    const result = await ClientRun.create(this._client, { ...this._target(), turnId: interaction.turnId }, { type: 'resume', interaction, response }, options).completed
    return result
  }

  /**
   * 明确批准当前整批工具；逐项做不同决定时使用 respond
   */
  public async approve(interaction: ClientInteraction, options: ClientObserveOptions = {}): Promise<ClientRunResult> {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    /** 等待本次恢复或取消操作完成后的结果，不另建会话或执行器 */
    const result = await this.respond(interaction, payload.actionRequests.map(action => ({ type: 'approve', callId: action.callId })), options)
    return result
  }

  /**
   * 明确拒绝当前整批工具，模型随后仍可继续解释或采用其他办法
   */
  public async reject(interaction: ClientInteraction, message?: string, options: ClientObserveOptions = {}): Promise<ClientRunResult> {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    /** 等待本次恢复或取消操作完成后的结果，不另建会话或执行器 */
    const result = await this.respond(interaction, payload.actionRequests.map(action => ({ type: 'reject', callId: action.callId, ...(message === undefined ? {} : { message }) })), options)
    return result
  }

  /**
   * 完整提交本批 approve、reject、edit 或 respond 决策，必须覆盖每个请求
   */
  public async respond(interaction: ClientInteraction, decisions: ToolApprovalDecision[], options: ClientObserveOptions = {}): Promise<ClientRunResult> {
    // 从捕获的交互中提取当前批次审批请求与允许的操作
    const payload = this._approval(interaction)
    // 校验后的整批人工决策，必须完整覆盖当前工具请求
    const response = readToolApprovalResponse({ decisions } as JsonValue, payload)
    if (!response)
      throw new TypeError('审批决策必须完整匹配当前请求与允许的操作')
    // 等待本次恢复或取消操作完成后的结果，不另建会话或执行器
    const result = await this.resume(interaction, response as unknown as JsonValue, options)
    return result
  }

  /**
   * 取消准确的待交互任务；与拒绝工具后继续模型推理不同
   */
  public async cancel(interaction: ClientInteraction, reason?: string, options: { signal?: AbortSignal } = {}): Promise<ClientRunResult> {
    this._assertInteraction(interaction)
    // 绑定本次新建或取消的精确运行身份，控制操作不追随其他 Turn
    const target = { ...this._target(), turnId: interaction.turnId }
    // Server 完成取消事务后返回的权威线程状态
    const state = await this._client.rpc.turn.cancel({ ...target, interruptId: interaction.interruptId, reason }, options)
    // 等待本次恢复或取消操作完成后的结果，不另建会话或执行器
    const result = readRunResult(target, state)
    if (!result)
      throw new Error('取消任务后缺少对应的终态记录')
    return result
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
