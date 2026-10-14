import type { Message, ModelTurnConfig, Part, TextPart, Tool, ToolResultPart, TurnModel } from '@elmino/llm'
import type { Promisable } from '@elmino/shared'
import type {
  RuntimeCanonicalMessageRecord,
  RuntimeCanonicalPartMetadataRecord,
  RuntimeCanonicalPartRecord,
  RuntimeStore,
  RuntimeToolCallRecord,
} from '@elmino/store'
import type { ContextProjectionState } from '@elmino/thread'
import type { PromptMessage } from '../hooks/index.js'
import { extractText } from '@elmino/llm'
import { canonicalRecordToMessage } from '@elmino/thread'
import { CONTEXT_COMPACTION_SUMMARY_PROMPT } from '../prompts/constants/index.js'
import { DEFAULT_MAX_TOKENS, ESCALATED_MAX_TOKENS, isPromptTooLongError } from '../recovery/index.js'
import { estimateTokens } from '../token/index.js'

/** -------------------- 类型 -------------------- */
/** 仅转换模型上下文消息，不写回原始历史 */
export type ContextProcessor = (messages: readonly PromptMessage[]) => Promisable<readonly PromptMessage[]>

/** ContextProjection 创建参数 */
export interface ContextProjectionOptions {
  /** 当前线程 Canonical Store */
  store: RuntimeStore
  /** 当前线程 ID */
  threadId: string
  /** 仅转换 Provider 消息，不写回 Canonical 历史 */
  process?: ContextProcessor
  /** 当前 Turn 冻结模型 */
  model: TurnModel<ModelTurnConfig>
  /** 已持久化的初始投影状态 */
  state: ContextProjectionState
  /** 需要上层观测的压缩事件回调 */
  onCompact?: () => Promisable<void>
  /** 生成摘要期间的瞬时状态回调 */
  onCompacting?: (compacting: boolean) => Promisable<void>
  /** 原生计数和摘要请求共用的取消信号 */
  signal?: AbortSignal
}

/** 当前模型请求中消息之外的上下文 */
export interface ContextProjectionRequest {
  /** 本轮系统提示词 */
  system?: TextPart[]
  /** 本轮工具声明 */
  tools?: Tool[]
}

/** Canonical 元数据窗口 */
interface CanonicalWindow {
  /** 当前摘要边界后的消息 */
  messages: RuntimeCanonicalMessageRecord[]
  /** 当前摘要边界后的 Part */
  parts: RuntimeCanonicalPartMetadataRecord[]
}

/** -------------------- 常量 -------------------- */
/** Canonical Context 投影策略 */
const CONTEXT_PROJECTION_LIMITS = {
  /** 自动压缩阈值占模型上下文窗口的比例 */
  pressureRatio: 0.75,
  /** 开始调用 Provider 原生 token 计数的阈值，相对于自动压缩线 */
  nativeCountTriggerRatio: 0.8,
  /** 摘要后优先保留的近期窗口比例 */
  recentWindowRatio: 0.15,
  /** 投影允许直接加载的近期工具结果预算比例 */
  recentToolResultRatio: 0.25,
  /** 首次及缩半重试的摘要输出预算比例 */
  summaryOutputRatios: [0.15, 0.25],
  /** 单个旧工具结果允许 Prune 的最低压力线比例 */
  pruneMinRatio: 0.02,
} as const

/** -------------------- 核心类 -------------------- */
/**
 * 从不可变 Canonical 历史生成 Provider Context，并统一执行 Prune 与滑动摘要
 */
export class ContextProjection {
  /** 当前可恢复投影状态 */
  private _state: ContextProjectionState

  /** 已完成压缩但尚未在 projection state 落盘后发布的事件数量 */
  private _pendingEventCount = 0

  /** 自动压缩压力线 */
  private readonly _pressureTokens: number

  /** 开始原生 token 计数的本地估算线 */
  private readonly _nativeCountTriggerTokens: number

  /**
   * 创建绑定单个线程的 ContextProjection
   */
  public static create(options: ContextProjectionOptions) {
    return new ContextProjection(options)
  }

  /**
   * 保存线程投影依赖并冻结当前模型预算
   */
  private constructor(private readonly _options: ContextProjectionOptions) {
    const contextTokens = _options.model.config.limit.context

    this._state = structuredClone(_options.state)
    this._pressureTokens = Math.max(
      1,
      Math.floor(contextTokens * CONTEXT_PROJECTION_LIMITS.pressureRatio),
    )
    this._nativeCountTriggerTokens = Math.max(
      1,
      Math.floor(
        this._pressureTokens
        * CONTEXT_PROJECTION_LIMITS.nativeCountTriggerRatio,
      ),
    )
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 从 Canonical 历史重建当前 Provider Context
   */
  public async project(throughSeq?: number) {
    const window = await this._readWindow(throughSeq)

    return this._projectWindow(
      window,
      this._selectPrunedPartIds(window),
    )
  }

  /**
   * 模型调用前按压力依次执行工具结果 Prune 和滑动摘要
   */
  public async beforeModelCall(
    request: ContextProjectionRequest = {},
  ) {
    const window = await this._readWindow()
    let prunedPartIds = this._selectPrunedPartIds(window)
    let contextMessages = await this._projectWindow(window, prunedPartIds)
    let count = await this.countInput(contextMessages, request)

    if (count.usedTokens < this._pressureTokens)
      return { contextMessages, ...count }

    if (prunedPartIds.size === 0) {
      prunedPartIds = this._selectPrunedPartIds(window, true)

      if (prunedPartIds.size > 0) {
        contextMessages = await this._projectWindow(window, prunedPartIds)
        count = await this.countInput(contextMessages, request)
      }
    }

    while (
      count.usedTokens >= this._pressureTokens
      && await this._summarize(await this._readWindow())
    ) {
      const previousTokens = count.usedTokens
      contextMessages = await this.project()
      count = await this.countInput(contextMessages, request)

      if (count.usedTokens >= previousTokens)
        break
    }

    if (count.usedTokens >= this._options.model.config.limit.context)
      throw new Error('压缩后上下文仍超出模型容量，请缩短输入或减少当前加载的内容后重试')

    return { contextMessages, ...count }
  }

  /**
   * 手动压缩或超限恢复时推进历史摘要
   */
  public async compactHistory() {
    await this._summarize(await this._readWindow(), true)

    return this.project()
  }

  /**
   * 统计完整 Provider 请求输入，临近压力线时优先使用原生计数
   */
  public async countInput(
    messages: Message[],
    request: ContextProjectionRequest = {},
  ) {
    const { system, tools } = request
    const estimatedTokens = estimateTokens(
      JSON.stringify({ messages, system, tools }),
    ).tokens
    const approximate = {
      usedTokens: estimatedTokens,
      estimation: 'approximate' as const,
    }
    const { adapter } = this._options.model

    if (
      !adapter.countTokens
      || estimatedTokens < this._nativeCountTriggerTokens
    ) {
      return approximate
    }

    try {
      const resolvedSystem = system ?? []
      const tokens = await adapter.countTokens({
        messages,
        system: resolvedSystem,
        tools,
      })

      return tokens === undefined || tokens <= 0
        ? approximate
        : { usedTokens: tokens, estimation: 'provider' as const }
    }
    catch {
      return approximate
    }
  }

  /**
   * 返回可持久化的独立 projection state
   */
  public readState() {
    return structuredClone(this._state)
  }

  /**
   * 在 projection state 已持久化后发布压缩观察事件
   */
  public async flushEvents() {
    const eventCount = this._pendingEventCount
    this._pendingEventCount = 0
    const notify = this._options.onCompact

    if (!notify)
      return

    for (let index = 0; index < eventCount; index++) {
      try {
        await notify()
      }
      catch (error) {
        // 摘要状态已经持久化，UI 边界发布失败不能回滚 ContextProjection 或阻断模型执行
        console.warn('[loop] 上下文压缩事件发布失败', error)
      }
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 只读当前摘要边界后的 Canonical 元数据
   */
  private async _readWindow(throughSeq?: number): Promise<CanonicalWindow> {
    const { store, threadId } = this._options
    const afterSeq = this._state.summary?.throughSeq
    const range = {
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(throughSeq === undefined ? {} : { throughSeq }),
    }
    const [messages, parts] = await Promise.all([
      store.canonical.list(threadId, range),
      store.canonical.listParts(threadId, range),
    ])

    return { messages, parts }
  }

  /**
   * 只加载未 Prune 的 BLOB，并在摘要前插入稳定边界标记
   */
  private async _projectWindow(
    window: CanonicalWindow,
    prunedPartIds: ReadonlySet<string>,
  ) {
    const contextMessages = normalizeProviderMessages(
      (await this._hydrateWindow(window, prunedPartIds)).map(item => item.message),
    )
    const summary = this._state.summary

    if (!summary)
      return contextMessages

    const summaryText = [
      `需要核对摘要前原文时，先使用 readContext({ id: "${summary.throughMessageId}", history: {} })`,
      '向前分页定位，再按 Message/Part ID 精确回读。',
    ].join('')

    return [
      {
        role: 'user',
        parts: [{
          type: 'text',
          text: [
            `[Context summary through canonical message ${summary.throughMessageId} (seq ${summary.throughSeq})]`,
            summary.text,
            summaryText,
          ].join('\n\n'),
        }],
      } satisfies Message,
      ...contextMessages,
    ]
  }

  /**
   * 加载未 Prune 的模型消息并执行不写回历史的扩展转换
   */
  private async _hydrateWindow(
    window: CanonicalWindow,
    prunedPartIds: ReadonlySet<string>,
  ) {
    const { store, threadId } = this._options
    const prunedParts = window.parts.filter(part => prunedPartIds.has(part.id))
    const [hydrated, tools] = await Promise.all([
      store.canonical.readParts(
        threadId,
        window.parts
          .filter(part => !prunedPartIds.has(part.id))
          .map(part => part.id),
      ),
      prunedParts.length > 0
        ? store.toolCalls.list({ threadId })
        : [],
    ])
    const contentByPartId = new Map(
      hydrated.map(part => [part.id, part.content as unknown as Part]),
    )
    const toolByResultPartId = new Map(tools.flatMap(tool => (
      tool.resultPartId ? [[tool.resultPartId, tool] as const] : []
    )))
    const partsByMessageId = groupPartsByMessage(window.parts)
    const messages = window.messages.map(record => ({
      id: record.id,
      turnId: record.turnId,
      message: canonicalRecordToMessage({
        ...record,
        parts: (partsByMessageId.get(record.id) ?? []).map(part => ({
          ...part,
          content: (
            prunedPartIds.has(part.id)
              ? createPrunedToolResult(
                  part,
                  toolByResultPartId.get(part.id),
                )
              : contentByPartId.get(part.id)!
          ) as unknown as RuntimeCanonicalPartRecord['content'],
        })),
      }),
    }))

    // 取消后的工具结算仍需重建快照，不执行请求处理器，避免覆盖原始中断原因
    if (this._options.signal?.aborted)
      return messages

    return this._options.process ? this._options.process(messages) : messages
  }

  /**
   * 仅根据 Canonical 元数据为当前模型窗口选择不加载的工具结果
   */
  private _selectPrunedPartIds(window: CanonicalWindow, force = false) {
    const result = new Set<string>()

    if (
      !force
      && estimateUnitTokens(window.messages, window.parts, new Set())
      < this._pressureTokens
    ) {
      return result
    }

    const minTokens = Math.max(
      1,
      Math.floor(
        this._pressureTokens * CONTEXT_PROJECTION_LIMITS.pruneMinRatio,
      ),
    )
    const budget = Math.max(
      minTokens,
      Math.floor(
        this._options.model.config.limit.context
        * CONTEXT_PROJECTION_LIMITS.recentToolResultRatio,
      ),
    )
    let usedTokens = 0

    for (let index = window.parts.length - 1; index >= 0; index--) {
      const part = window.parts[index]!

      if (part.type !== 'tool-result')
        continue
      const tokens = estimatePartTokens(part)

      if (tokens < minTokens)
        continue
      if (usedTokens + tokens <= budget) {
        usedTokens += tokens
        continue
      }

      result.add(part.id)
    }

    return result
  }

  /**
   * 把近期窗口之前的新历史与 previous summary 合并成下一版滑动摘要
   */
  private async _summarize(
    window: CanonicalWindow,
    force = false,
  ) {
    const { store, threadId } = this._options
    const units = groupSummaryUnits(window.messages)

    if (units.length === 0)
      return false

    const toolCalls = await store.toolCalls.list({ threadId })
    const messageIdByPartId = new Map(
      window.parts.map(part => [part.id, part.messageId]),
    )
    const protectedMessageIds = new Set(toolCalls.flatMap(toolCall => (
      toolCall.resultPartId === null
        ? [messageIdByPartId.get(toolCall.assistantPartId)].filter(Boolean)
        : []
    )))
    // 未结算调用所在 sampling 单元及其后历史必须完整留在 Provider Context
    const protectedUnitIndex = units.findIndex(unit => (
      unit.some(message => protectedMessageIds.has(message.id))
    ))
    const summarizableUnitCount = protectedUnitIndex < 0
      ? units.length
      : protectedUnitIndex

    if (summarizableUnitCount === 0)
      return false

    const recentBudget = Math.max(
      1,
      Math.floor(
        this._options.model.config.limit.context * CONTEXT_PROJECTION_LIMITS.recentWindowRatio,
      ),
    )
    const prunedPartIds = this._selectPrunedPartIds(window, true)
    let recentTokens = units
      .slice(summarizableUnitCount)
      .reduce((total, unit) => (
        total + estimateUnitTokens(unit, window.parts, prunedPartIds)
      ), 0)
    let headUnitCount = summarizableUnitCount

    for (let index = summarizableUnitCount - 1; index >= 0; index--) {
      const unit = units[index]!
      const tokens = estimateUnitTokens(unit, window.parts, prunedPartIds)
      const canStop = units.length === 1
        || index < summarizableUnitCount - 1
        || summarizableUnitCount < units.length

      if (canStop && recentTokens + tokens > recentBudget)
        break

      recentTokens += tokens
      headUnitCount = index
    }

    if (force && headUnitCount === 0)
      headUnitCount = 1

    let attemptHeadUnitCount = headUnitCount
    let summary: string | undefined
    let through: RuntimeCanonicalMessageRecord | undefined
    const outputBudgets = CONTEXT_PROJECTION_LIMITS.summaryOutputRatios.map((ratio, index) => Math.max(
      1,
      Math.min(
        Math.floor(this._options.model.config.limit.context * ratio),
        index === 0 ? DEFAULT_MAX_TOKENS : ESCALATED_MAX_TOKENS,
      ),
    ))
    /** 记录摘要缩半重试的原因与预算变化 */
    const retrySummary = (reason: 'output_truncated' | 'prompt_too_long') => {
      const previousHeadUnitCount = attemptHeadUnitCount
      attemptHeadUnitCount = Math.ceil(attemptHeadUnitCount / 2)
      console.warn('[loop] 上下文摘要缩半重试', {
        threadId,
        reason,
        previousHeadUnitCount,
        headUnitCount: attemptHeadUnitCount,
        previousMaxOutputTokens: outputBudgets[0],
        maxOutputTokens: outputBudgets[1],
      })
    }
    await this._options.onCompacting?.(true)

    try {
      for (
        let attempt = 0;
        attempt < CONTEXT_PROJECTION_LIMITS.summaryOutputRatios.length;
        attempt++
      ) {
        const head = units.slice(0, attemptHeadUnitCount).flat()
        const maxOutputTokens = outputBudgets[attempt]!

        if (head.length === 0)
          return false

        try {
          const generated = await this._generateSummary(
            head,
            window,
            prunedPartIds,
            maxOutputTokens,
          )

          if (generated.truncated) {
            if (attempt === 0 && attemptHeadUnitCount > 1) {
              retrySummary('output_truncated')
              continue
            }

            throw new Error('上下文摘要输出被截断')
          }

          summary = generated.text
          through = head.at(-1)!
          break
        }
        catch (error) {
          if (
            attempt === 0
            && attemptHeadUnitCount > 1
            && isPromptTooLongError(error)
          ) {
            retrySummary('prompt_too_long')
            continue
          }

          throw error
        }
      }
    }
    finally {
      await this._options.onCompacting?.(false)
    }

    if (!summary || !through)
      throw new Error('上下文摘要失败')

    this._state = {
      summary: {
        text: summary,
        throughSeq: through.seq,
        throughMessageId: through.id,
      },
    }
    this._pendingEventCount++

    return true
  }

  /**
   * 使用一个连续 Canonical 前缀生成单次文本摘要
   */
  private async _generateSummary(
    head: RuntimeCanonicalMessageRecord[],
    window: CanonicalWindow,
    prunedPartIds: ReadonlySet<string>,
    maxOutputTokens: number,
  ) {
    const headIds = new Set(head.map(message => message.id))
    const headParts = window.parts.filter(part => headIds.has(part.messageId))
    const projected = await this._hydrateWindow({
      messages: head,
      parts: headParts,
    }, prunedPartIds)
    const recordsById = new Map(head.map(record => [record.id, record]))
    const partIdsByMessageId = groupPartsByMessage(headParts)
    const conversation = JSON.stringify({
      previousSummary: this._state.summary?.text,
      canonicalMessages: projected.map(({ id, message: source }) => {
        const record = recordsById.get(id)!
        const message = projectSummaryMessage(source)

        return {
          id: record.id,
          seq: record.seq,
          turnId: record.turnId,
          partIds: (partIdsByMessageId.get(record.id) ?? []).map(part => part.id),
          message,
        }
      }),
    })
    const prompt = CONTEXT_COMPACTION_SUMMARY_PROMPT.format({ conversation })
    const { message, usage } = await this._options.model.adapter.stream({
      messages: [{
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
      }],
      system: [],
      maxOutputTokens,
      cache: { mode: 'disabled' },
      signal: this._options.signal,
    })
    const text = extractText(message).trim()

    if (!text)
      throw new Error('上下文摘要为空')

    return {
      text,
      truncated: message.finishReason === 'truncated'
        || usage.output >= maxOutputTokens,
    }
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 按 Canonical Message ID 聚合 Part 元数据
 */
function groupPartsByMessage(parts: RuntimeCanonicalPartMetadataRecord[]) {
  const groups = new Map<string, RuntimeCanonicalPartMetadataRecord[]>()

  for (const part of parts) {
    const group = groups.get(part.messageId) ?? []

    group.push(part)
    groups.set(part.messageId, group)
  }

  return groups
}

/**
 * 把 Canonical ToolResult 贴回所属 assistant 批次，并移除不可重放的空消息
 */
function normalizeProviderMessages(messages: Message[]) {
  const source = messages.filter(message => message.parts.length > 0)
  const assistantByCallId = new Map<string, number>()
  const resultsByAssistant = new Map<number, Map<string, ToolResultPart>>()
  const remainingByToolMessage = new Map<number, Part[]>()

  for (const [messageIndex, message] of source.entries()) {
    if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part.type === 'tool-call')
          assistantByCallId.set(part.id, messageIndex)
      }

      continue
    }
    if (message.role !== 'tool')
      continue
    const remaining: Part[] = []

    for (const part of message.parts) {
      if (part.type !== 'tool-result') {
        remaining.push(part)
        continue
      }
      const assistantIndex = assistantByCallId.get(part.callId)

      if (assistantIndex === undefined) {
        remaining.push(part)
        continue
      }
      const results = resultsByAssistant.get(assistantIndex) ?? new Map()

      results.set(part.callId, part)
      resultsByAssistant.set(assistantIndex, results)
    }

    remainingByToolMessage.set(messageIndex, remaining)
  }

  return source.flatMap((message, messageIndex): Message[] => {
    if (message.role === 'tool') {
      const parts = remainingByToolMessage.get(messageIndex) ?? []

      return parts.length > 0 ? [{ ...message, parts }] : []
    }
    const results = resultsByAssistant.get(messageIndex)

    if (!results)
      return [message]
    const parts = message.parts.flatMap((part) => {
      if (part.type !== 'tool-call')
        return []
      const result = results.get(part.id)

      return result ? [result] : []
    })

    return parts.length > 0
      ? [message, { role: 'tool', parts }]
      : [message]
  })
}

/**
 * 将 Prune 的工具结果恢复成可配对且可直接回读的短占位符
 */
function createPrunedToolResult(
  part: RuntimeCanonicalPartMetadataRecord,
  tool?: RuntimeToolCallRecord,
): ToolResultPart {
  return {
    type: 'tool-result',
    callId: tool?.providerCallId ?? part.id,
    ...(tool?.name ? { name: tool.name } : {}),
    result: `工具结果已从当前上下文 Prune。使用 readContext({ id: "${part.id}" }) 分页读取完整原文。`,
    ...(tool?.status === 'failed' ? { error: true } : {}),
  }
}

/**
 * 按 Turn 与已完成 Provider sampling 边界聚合安全摘要单元
 */
function groupSummaryUnits(messages: RuntimeCanonicalMessageRecord[]) {
  const units: RuntimeCanonicalMessageRecord[][] = []

  for (const message of messages) {
    const current = units.at(-1)
    const sameTurn = current?.[0]?.turnId === message.turnId
    const hasAssistant = current?.some(item => item.role === 'assistant')

    if (current && sameTurn && !(message.role === 'assistant' && hasAssistant))
      current.push(message)
    else
      units.push([message])
  }

  return units
}

/**
 * 用 BLOB 字节元数据近似单个 Part token 数
 */
function estimatePartTokens(part: RuntimeCanonicalPartMetadataRecord) {
  return Math.ceil(part.sizeBytes / 4)
}

/**
 * 估算完整 Turn 的 Canonical Part token 数
 */
function estimateUnitTokens(
  messages: RuntimeCanonicalMessageRecord[],
  parts: RuntimeCanonicalPartMetadataRecord[],
  prunedPartIds: ReadonlySet<string>,
) {
  const messageIds = new Set(messages.map(message => message.id))

  return parts.reduce((total, part) => (
    messageIds.has(part.messageId)
      ? total + (prunedPartIds.has(part.id) ? 64 : estimatePartTokens(part))
      : total
  ), messages.length * 8)
}

/**
 * 摘要输入移除 Provider 私有续接字段但保留可回读的 Canonical ID
 */
function projectSummaryMessage(message: Message): Message {
  return {
    role: message.role,
    parts: message.parts.flatMap((part): Part[] => {
      if (part.type === 'reasoning') {
        return part.visibility === 'context-only'
          ? []
          : [{ type: 'reasoning', text: part.text }]
      }
      if (part.type === 'tool-call') {
        return [{
          type: 'tool-call',
          id: part.id,
          name: part.name,
          args: part.args,
        }]
      }

      return [part]
    }),
  }
}
