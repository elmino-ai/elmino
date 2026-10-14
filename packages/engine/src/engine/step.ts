import type {
  CountTokensRequest,
  Event,
  EventHandler,
  Message,
  ModelTurnConfig,
  ObjectResult,
  Provider,
  ProviderCapabilities,
  Request,
  Result,
  TurnModel,
  Usage,
} from '@elmino/llm'
import type { Except, Promisable } from '@elmino/shared'
import type { RuntimeStore } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import type { z } from 'zod'
import { ObjectParseError } from '@elmino/llm'
import { estimateTokens } from '@elmino/loop'
import { createRuntimeEvent, readAffectedThreadUsages } from '@elmino/thread'
/** -------------------- 类型 -------------------- */
/** Turn Step 记账器参数 */
interface TurnStepTrackerOptions {
  /** 当前 Turn 冻结模型 */
  model: TurnModel<ModelTurnConfig>
  /** 当前 Turn ID */
  turnId: string
  /** 当前线程 ID */
  threadId: string
  /** RuntimeStore 权威事实存储 */
  store: RuntimeStore
  /** 运行态事件出口 */
  onRuntimeEvent?: (event: RuntimeEvent) => Promisable<void>
}

/** Step 用量结算参数 */
interface SettleStepInput {
  /** 本地完整输入估算 */
  estimatedInput: number
  /** 本地已生成输出估算 */
  estimatedOutput: number
  /** 是否取得完整 Provider 响应 */
  finalResponse: boolean
  /** Step ID */
  stepId: string
  /** Provider 已报告用量 */
  providerUsage?: Usage
  /** Step 终态 */
  status: 'completed' | 'failed' | 'interrupted'
}

/** -------------------- 核心函数 -------------------- */
/**
 * 为当前 Turn 创建统一记录全部 Provider sampling Step 的冻结模型
 */
export function createTrackedTurnModel(
  options: TurnStepTrackerOptions,
): TurnModel<ModelTurnConfig> {
  return {
    config: options.model.config,
    adapter: TurnStepTracker.create(options),
  }
}

/** -------------------- 核心类 -------------------- */
/**
 * 在 Provider 边界持久化每次 Step 事实
 */
class TurnStepTracker implements Provider {
  /** Provider 稳定名称 */
  public readonly name: string

  /** Provider 原生模型名称 */
  public readonly model: string

  /** 当前 Provider 与模型能力 */
  public readonly capabilities: ProviderCapabilities

  /** 原生 token 计数能力只透传，不产生 Step */
  public readonly countTokens?: (request: CountTokensRequest) => Promise<number | undefined>

  /** 原始 Provider */
  private readonly _provider: Provider

  /**
   * 创建当前 Turn 的 Step 记账器
   */
  public static create(options: TurnStepTrackerOptions) {
    return new TurnStepTracker(options)
  }

  /**
   * 保存 Turn 归属和 Provider 能力
   */
  private constructor(private readonly _options: TurnStepTrackerOptions) {
    this._provider = _options.model.adapter
    this.name = this._provider.name
    this.model = this._provider.model
    this.capabilities = this._provider.capabilities
    this.countTokens = this._provider.countTokens?.bind(this._provider)
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 记录一次非流式生成
   */
  public async generate(request: Request): Promise<Result> {
    const estimatedInput = this._estimateInput(request)
    const { id: stepId } = await this._createStep(estimatedInput)

    try {
      const result = await this._provider.generate(request)
      const estimatedOutput = this._estimateResponse(result.message)

      await this._settleStep({
        stepId,
        status: 'completed',
        providerUsage: result.usage,
        estimatedInput,
        estimatedOutput,
        finalResponse: true,
      })
      return result
    }
    catch (error) {
      await this._settleFailedStep({
        stepId,
        signal: request.signal,
        estimatedInput,
        estimatedOutput: 0,
        finalResponse: false,
        error,
      })
      throw error
    }
  }

  /**
   * 记录一次流式生成并保留中断前累计用量
   */
  public async stream(request: Request, onEvent?: EventHandler): Promise<Result> {
    const estimatedInput = this._estimateInput(request)
    const { id: stepId } = await this._createStep(estimatedInput)
    let providerUsage: Usage | undefined
    let partialText = ''
    const partialTools = new Map<number, string>()

    /** 累积流式输出并继续转发原始统一事件 */
    const handleEvent = async (event: Event) => {
      if (event.type === 'part-delta' && event.delta.type === 'tool-args')
        partialTools.set(event.index, `${partialTools.get(event.index) ?? ''}${event.delta.text}`)
      else if (event.type === 'part-delta')
        partialText += event.delta.text
      else if (event.type === 'part-end' && event.part.type === 'tool-call')
        partialTools.set(event.index, JSON.stringify(event.part))
      else if (event.type === 'usage')
        providerUsage = event.usage

      await onEvent?.(event)
    }

    try {
      const result = await this._provider.stream(request, handleEvent)
      const estimatedOutput = this._estimateResponse(result.message)

      await this._settleStep({
        stepId,
        status: 'completed',
        providerUsage: result.usage,
        estimatedInput,
        estimatedOutput,
        finalResponse: true,
      })
      return result
    }
    catch (error) {
      const estimatedOutput = estimateTokens([
        partialText,
        ...partialTools.values(),
      ].filter(Boolean).join('\n')).tokens

      await this._settleFailedStep({
        stepId,
        signal: request.signal,
        estimatedInput,
        estimatedOutput,
        providerUsage,
        finalResponse: false,
        error,
      })
      throw error
    }
  }

  /**
   * 记录一次结构化对象生成
   */
  public async generateObject<TSchema extends z.ZodType>(
    request: Omit<Request, 'responseFormat'> & {
      /** 输出 Schema */
      schema: TSchema
      /** 输出 Schema 名称 */
      schemaName?: string
    },
  ): Promise<ObjectResult<TSchema>> {
    const estimatedInput = this._estimateInput(request)
    const { id: stepId } = await this._createStep(estimatedInput)

    try {
      const result = await this._provider.generateObject(request)
      const estimatedOutput = this._estimateResponse(result.message)

      await this._settleStep({
        stepId,
        status: 'completed',
        providerUsage: result.usage,
        estimatedInput,
        estimatedOutput,
        finalResponse: true,
      })
      return result
    }
    catch (error) {
      const result = error instanceof ObjectParseError
        ? error.result
        : undefined
      const estimatedOutput = result
        ? this._estimateResponse(result.message)
        : 0

      await this._settleFailedStep({
        stepId,
        signal: request.signal,
        estimatedInput,
        estimatedOutput,
        providerUsage: result?.usage,
        finalResponse: Boolean(result),
        error,
      })
      throw error
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 创建带调用前输入估算的 Step
   */
  private _createStep(estimatedInput: number) {
    return this._options.store.steps.create({
      turnId: this._options.turnId,
      input: estimatedInput,
      estimated: estimatedInput,
    })
  }

  /**
   * 结算失败或中断并在存储失败时保留原始错误
   */
  private async _settleFailedStep(
    input: Except<SettleStepInput, 'status'> & {
      /** 当前生成取消信号 */
      signal?: AbortSignal | null
      /** 原始生成错误 */
      error: unknown
    },
  ) {
    const { error, signal, ...step } = input

    try {
      await this._settleStep({
        ...step,
        status: signal?.aborted
          ? 'interrupted'
          : 'failed',
      })
    }
    catch (settleError) {
      throw new AggregateError(
        [error, settleError],
        '模型生成失败且用量结算失败',
      )
    }
  }

  /**
   * 按 Provider 字段优先级结算 Step 并发布派生用量
   */
  private async _settleStep(input: SettleStepInput) {
    const usage = normalizeStepUsage(input)

    await this._options.store.steps.settle(input.stepId, {
      status: input.status,
      ...usage,
    })
    await this._publishUsage()
  }

  /**
   * 广播当前线程和全部祖先线程的最新任务用量
   */
  private async _publishUsage() {
    if (!this._options.onRuntimeEvent)
      return

    let projections

    try {
      projections = await readAffectedThreadUsages(
        this._options.store,
        this._options.threadId,
      )
    }
    catch (error) {
      // Step 已经持久化，投影失败不能触发模型重试和重复消费
      console.warn(`[step] 用量投影失败 thread=${this._options.threadId}`, error)
      return
    }

    for (const projection of projections) {
      const { threadId, ...payload } = projection
      const turnId = threadId === this._options.threadId
        ? this._options.turnId
        : undefined

      try {
        await this._options.onRuntimeEvent(createRuntimeEvent({
          type: 'token.usage',
          threadId,
          turnId,
          payload,
        }))
      }
      catch (error) {
        // 单个线程通知失败不影响其他祖先线程取得任务总用量
        console.warn(`[step] 用量事件发布失败 thread=${threadId}`, error)
      }
    }
  }

  /**
   * 估算 Provider 可见的输入上下文
   */
  private _estimateInput(request: Pick<Request, 'messages' | 'system' | 'tools'>) {
    return estimateTokens(JSON.stringify({
      messages: request.messages,
      system: request.system,
      tools: request.tools,
    })).tokens
  }

  /**
   * 估算 Provider 原始响应全部内容
   */
  private _estimateResponse(message: Message) {
    return estimateTokens(JSON.stringify(message.parts)).tokens
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 按统一 Usage 与本地估算结算 Step 事实
 */
function normalizeStepUsage(input: SettleStepInput) {
  const provider = input.providerUsage && hasReportedUsage(input.providerUsage)
    ? input.providerUsage
    : undefined
  const reportedInput = provider?.input
  const reportedOutput = provider?.output
  const inputTokens = reportedInput ?? input.estimatedInput
  const outputTokens = input.finalResponse && reportedOutput !== undefined
    ? reportedOutput
    : Math.max(reportedOutput ?? 0, input.estimatedOutput)
  const estimatedInput = reportedInput === undefined ? inputTokens : 0
  const estimatedOutput = reportedOutput === undefined
    ? outputTokens
    : input.finalResponse
      ? 0
      : Math.max(outputTokens - reportedOutput, 0)

  return {
    input: inputTokens,
    output: outputTokens,
    reasoning: provider?.reasoning ?? 0,
    cacheWrite: provider?.cacheWrite ?? 0,
    cacheRead: provider?.cacheRead ?? 0,
    estimated: estimatedInput + estimatedOutput,
  }
}

/**
 * 区分 Provider 权威零值和兼容服务未返回 Usage 后产生的空标准化对象
 */
function hasReportedUsage(usage: Usage) {
  return usage.raw !== undefined
    || usage.input > 0
    || usage.output > 0
    || usage.reasoning > 0
    || usage.cacheRead > 0
    || usage.cacheWrite > 0
}
