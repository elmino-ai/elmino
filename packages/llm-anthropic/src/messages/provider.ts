import type Anthropic from '@anthropic-ai/sdk'
import type {
  CacheControl,
  CountTokensRequest,
  EventHandler,
  FinishReason,
  Message,
  ObjectResult,
  Part,
  Provider,
  ProviderCapabilities,
  Request,
  Result,
  Usage,
} from '@elmino/llm'
import type { ProviderAuth, ProviderOptions } from '@elmino/llm/provider'
import type { ProviderReuseStrategy } from '../policy/reuse.js'
import AnthropicClient from '@anthropic-ai/sdk'
import { EMPTY_USAGE, mergeUsage, parseObject } from '@elmino/llm'
import { createAssistantMessage, createToolCall, createToolCallStart, rawRecord, tokenCount } from '@elmino/llm/adapter'
import { resolveProviderAuth } from '@elmino/llm/provider'
import { z } from 'zod'
import { resolveReuse } from '../policy/reuse.js'

/** -------------------- 类型 -------------------- */
/** Anthropic 适配器配置 */
interface AnthropicMessagesProviderContext {
  /** Anthropic Messages 接口地址 */
  baseURL?: string
  /** Provider 工厂已经解析的内部认证策略 */
  auth: ProviderAuth
  /** Provider 原生模型名 */
  model: string
  /** 模型是否支持原生 JSON Schema */
  jsonSchema?: boolean
  /** Provider 稳定名称 */
  providerName: string
  /** 当前供应商与 Anthropic 协议的请求复用策略 */
  reuse: ProviderReuseStrategy
}

/** Anthropic 文本流的前缀探测状态 */
interface AnthropicTextStreamState {
  /** 尚未确认是否属于序列化 thinking 的前缀 */
  buffer: string
  /** 已确认后续增量都是普通正文 */
  passthrough: boolean
}

/** 序列化 thinking 前缀剥离结果 */
interface AnthropicTextProjection {
  /** 是否仍需等待更多字符才能判断 */
  pending: boolean
  /** 去掉序列化 thinking 后的正文 */
  text: string
}

/** Anthropic SDK 可接受的请求对象 */
type AnthropicRequest = Anthropic.Messages.MessageCreateParamsNonStreaming & {
  /** Anthropic 顶层自动缓存 */
  cache_control?: { type: 'ephemeral' }
}

/** -------------------- 核心类 -------------------- */
/**
 * 将 Anthropic Messages API 投影为项目统一 Provider
 */
export class AnthropicMessagesProvider implements Provider {
  /** Provider 稳定名称 */
  public readonly name: string
  /** Provider 原生模型名 */
  public readonly model: string
  /** 当前模型能力 */
  public readonly capabilities: ProviderCapabilities

  /** Anthropic SDK 客户端 */
  private readonly _client: AnthropicClient
  /** 当前供应商与 Anthropic 协议的请求复用策略 */
  private readonly _reuse: ProviderReuseStrategy
  /** 当前 Turn 是否继续尝试原生 token 计数 */
  private _countTokensAvailable = true

  /**
   * 创建 Anthropic Provider
   */
  public static create(config: ProviderOptions) {
    const { baseURL, jsonSchema, model, providerName = 'anthropic', cache = { mode: 'automatic' } } = config
    const auth = resolveProviderAuth(config, providerName === 'mimo' ? 'bearer' : 'api-key', providerName)
    const reuse = resolveReuse(cache, model, providerName)

    return new AnthropicMessagesProvider({ auth, baseURL, jsonSchema, model, providerName, reuse })
  }

  /**
   * 保存已经解析的模型与认证配置
   */
  private constructor(config: AnthropicMessagesProviderContext) {
    const { auth, baseURL, jsonSchema = true, model, providerName, reuse } = config

    this.name = providerName
    this.model = model
    this.capabilities = {
      cache: reuse.cache,
      reasoning: true,
      tools: true,
      jsonSchema,
    }
    this._reuse = reuse
    this._client = new AnthropicClient({
      baseURL,
      apiKey: auth.type === 'api-key' ? auth.credential : null,
      authToken: auth.type === 'bearer' ? auth.credential : null,
      // Anthropic SDK 默认读取环境变量，免认证时必须显式清除原生认证头
      defaultHeaders: auth.type === 'none' ? { 'X-Api-Key': null } : undefined,
    })
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 使用 Anthropic 原生端点统计输入 token
   */
  public async countTokens(request: CountTokensRequest) {
    if (!this._countTokensAvailable)
      return undefined

    try {
      const body = this._createBody({
        ...request,
        cache: { mode: 'disabled', breakpoints: [] },
        maxOutputTokens: 1,
      })
      const { max_tokens: _, ...input } = body
      const result = await this._client.messages.countTokens(input)

      return result.input_tokens
    }
    catch {
      // 兼容未实现 count_tokens 的 Anthropic 兼容服务，后续由调用方本地估算
      this._countTokensAvailable = false
      return undefined
    }
  }

  /**
   * 非流式生成完整消息
   */
  public async generate(request: Request): Promise<Result> {
    const input = this._request(request)
    const response = await this._client.messages.create(
      this._createBody(input),
      { signal: input.signal },
    )

    return this._result(response)
  }

  /**
   * 流式生成并投影统一 Event
   */
  public async stream(request: Request, onEvent?: EventHandler): Promise<Result> {
    const input = this._request(request)
    const stream = this._client.messages.stream(
      { ...this._createBody(input), stream: true },
      { signal: input.signal },
    )
    const toolArgs = new Map<number, string>()
    const textStreams = new Map<number, AnthropicTextStreamState>()
    let usage: Usage = EMPTY_USAGE

    /** 仅缓冲可能是序列化 thinking 的 JSON 前缀，普通正文确认后立即透传 */
    const forwardText = async (index: number, delta: string, final = false) => {
      const state = textStreams.get(index) ?? { buffer: '', passthrough: false }

      textStreams.set(index, state)
      if (state.passthrough) {
        if (delta) {
          await onEvent?.({
            type: 'part-delta',
            index,
            delta: { type: 'text', text: delta },
          })
        }
        return undefined
      }

      state.buffer += delta
      const projection = stripSerializedThinkingPrefix(state.buffer, final)

      if (projection.pending) {
        state.buffer = projection.text
        return undefined
      }

      state.buffer = ''
      state.passthrough = true
      if (projection.text) {
        await onEvent?.({
          type: 'part-delta',
          index,
          delta: { type: 'text', text: projection.text },
        })
      }
    }

    for await (const event of stream) {
      if (event.type === 'message_start') {
        usage = this._usage(event.message.usage)
        await onEvent?.({ type: 'usage', usage })
        continue
      }

      if (event.type === 'message_delta') {
        usage = mergeUsage(usage, this._usage(event.usage))
        await onEvent?.({ type: 'usage', usage })
        continue
      }

      if (event.type === 'content_block_start') {
        const part = this._part(event.content_block)
        const toolInput = event.content_block.type === 'tool_use'
          ? rawRecord(event.content_block.input)
          : undefined
        const initialArgs = toolInput && Object.keys(toolInput).length > 0
          ? JSON.stringify(toolInput)
          : ''

        if (initialArgs)
          toolArgs.set(event.index, initialArgs)
        if (event.content_block.type === 'text')
          textStreams.set(event.index, { buffer: event.content_block.text, passthrough: false })
        if (part && (part.type !== 'reasoning' || part.visibility !== 'context-only')) {
          const startedPart = part.type === 'tool-call'
            ? createToolCallStart(part.id, part.name, part.metadata)
            : part.type === 'text' ? { type: 'text' as const, text: '' } : part

          await onEvent?.({
            type: 'part-start',
            index: event.index,
            part: startedPart,
          })
          if (initialArgs) {
            await onEvent?.({
              type: 'part-delta',
              index: event.index,
              delta: { type: 'tool-args', text: initialArgs },
            })
          }
        }
        continue
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          await forwardText(event.index, event.delta.text)
        }
        else if (event.delta.type === 'thinking_delta') {
          await onEvent?.({
            type: 'part-delta',
            index: event.index,
            delta: { type: 'reasoning', text: event.delta.thinking },
          })
        }
        else if (event.delta.type === 'input_json_delta') {
          const argsText = `${toolArgs.get(event.index) ?? ''}${event.delta.partial_json}`

          toolArgs.set(event.index, argsText)
          await onEvent?.({
            type: 'part-delta',
            index: event.index,
            delta: { type: 'tool-args', text: event.delta.partial_json },
          })
        }
        continue
      }

      if (event.type === 'content_block_stop') {
        if (textStreams.has(event.index))
          await forwardText(event.index, '', true)

        const block = stream.currentMessage?.content[event.index]
        const parts = block ? this._parts(block, toolArgs.get(event.index)) : []
        const part = parts.find(item => item.type !== 'reasoning' || item.visibility !== 'context-only')
          ?? (block?.type === 'text' ? { type: 'text' as const, text: '' } : undefined)

        if (part)
          await onEvent?.({ type: 'part-end', index: event.index, part })
      }
    }

    const result = this._result(await stream.finalMessage())

    await onEvent?.({ type: 'usage', usage: result.usage })
    return result
  }

  /**
   * 使用 Anthropic 原生 JSON Schema 或纯 JSON 指令生成结构化对象
   */
  public async generateObject<TSchema extends z.ZodType>(
    request: Omit<Request, 'responseFormat'> & { schema: TSchema, schemaName?: string },
  ): Promise<ObjectResult<TSchema>> {
    const { schema, schemaName = 'response', ...input } = request
    const jsonSchema = z.toJSONSchema(schema) as unknown as Record<string, unknown>
    const result = await this.generate({
      ...input,
      system: this.capabilities.jsonSchema
        ? input.system
        : [
            ...input.system,
            { type: 'text', text: `仅返回符合以下 JSON Schema 的 JSON：\n${JSON.stringify(jsonSchema)}` },
          ],
      responseFormat: this.capabilities.jsonSchema
        ? { type: 'json-schema', name: schemaName, schema: jsonSchema }
        : undefined,
      // 结构化输出预算只用于 JSON 正文，不能继承模型默认或调用方配置的 thinking
      reasoning: 'disabled',
    })

    return parseObject(result, schema)
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 应用 Anthropic 适配器内部缓存策略并校验可选覆盖
   */
  private _request(request: Request): Request & { cache: CacheControl } {
    return this._reuse.resolve(request)
  }

  /**
   * 创建 Anthropic 原生请求
   */
  private _createBody(request: Request & { cache: CacheControl }): AnthropicRequest {
    const { cache, maxOutputTokens, messages, reasoning, responseFormat, system, tools } = request
    const nativeReasoning = reasoning === 'disabled'
      ? { thinking: { type: 'disabled' } }
      : reasoning
    const breakpoints = new Set(cache.breakpoints)
    const nativeSystem = system.map((part, index) => ({
      type: 'text' as const,
      text: part.text,
      ...(cache.mode === 'explicit'
        && breakpoints.has('system')
        && index === system.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }))
    const nativeTools = tools?.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema as unknown as Anthropic.Messages.Tool.InputSchema,
      ...(cache.mode === 'explicit'
        && breakpoints.has('tools')
        && index === tools.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }))
    const latestUser = messages.findLastIndex(message => message.role === 'user' || message.role === 'tool')
    const nativeMessages = messages
      .filter(message => message.role !== 'system')
      .map((message, index) => this._message(
        message,
        cache.mode === 'explicit'
        && breakpoints.has('latest-user')
        && index === latestUser,
      ))
    const body: AnthropicRequest = {
      model: this.model,
      max_tokens: maxOutputTokens,
      messages: nativeMessages,
      system: nativeSystem.length > 0 ? nativeSystem : undefined,
      tools: nativeTools,
      temperature: request.temperature,
      top_p: request.topP,
      ...(nativeReasoning ?? {}),
    }

    if (cache.mode === 'automatic' && this._reuse.automaticControl)
      body.cache_control = { type: 'ephemeral' }
    if (responseFormat) {
      Object.assign(body, {
        output_config: {
          format: {
            type: 'json_schema',
            schema: responseFormat.schema,
          },
        },
      })
    }

    return body
  }

  /**
   * 映射单条公共消息并在指定末尾放置缓存断点
   */
  private _message(message: Message, cacheEnabled?: boolean): Anthropic.Messages.MessageParam {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const parts = message.parts.map((part) => {
      if (part.type === 'text')
        return { type: 'text' as const, text: part.text }
      if (part.type === 'reasoning') {
        if (part.metadata?.redacted === true && part.signature) {
          return {
            type: 'redacted_thinking' as const,
            data: part.signature,
          }
        }
        if (part.metadata?.serialized === true) {
          return {
            type: 'text' as const,
            text: JSON.stringify({
              type: 'thinking',
              signature: part.signature,
              thinking: part.text,
            }),
          }
        }

        return part.signature
          ? { type: 'thinking' as const, thinking: part.text, signature: part.signature }
          : { type: 'text' as const, text: part.text }
      }
      if (part.type === 'image') {
        const data = part.data.replace(/^data:[^;]+;base64,/, '')

        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: part.mime as Anthropic.Messages.Base64ImageSource['media_type'],
            data,
          },
        }
      }
      if (part.type === 'document') {
        const data = part.data.replace(/^data:[^;]+;base64,/, '')

        return {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data,
          },
        }
      }
      if (part.type === 'tool-call') {
        return {
          type: 'tool_use' as const,
          id: part.id,
          name: part.name,
          input: part.args,
        }
      }

      return {
        type: 'tool_result' as const,
        tool_use_id: part.callId,
        is_error: part.error,
        content: typeof part.result === 'string'
          ? part.result
          : part.result.map(item => item.type === 'text'
              ? { type: 'text' as const, text: item.text }
              : {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: item.mime as Anthropic.Messages.Base64ImageSource['media_type'],
                    data: item.data.replace(/^data:[^;]+;base64,/, ''),
                  },
                }),
      }
    })
    const last = parts.length - 1
    const content = cacheEnabled && last >= 0
      ? parts.map((part, index) => index === last
          ? { ...part, cache_control: { type: 'ephemeral' as const } }
          : part)
      : parts

    return { role, content } as Anthropic.Messages.MessageParam
  }

  /**
   * 将 Anthropic 完整响应映射成公共结果
   */
  private _result(response: Anthropic.Messages.Message): Result {
    const finishReason = this._finishReason(response.stop_reason)
    const parts = response.content
      .flatMap(block => this._parts(block))
    const metadata = rawRecord({
      model: response.model,
      type: response.type,
    })

    return {
      message: createAssistantMessage({
        id: response.id,
        parts,
        finishReason,
        rawFinishReason: response.stop_reason,
        metadata,
      }),
      usage: this._usage(response.usage),
    }
  }

  /**
   * 将 Anthropic 内容块映射成公共 Part
   */
  private _part(block: Anthropic.Messages.ContentBlock, streamedArgs?: string): Part | undefined {
    if (block.type === 'text')
      return { type: 'text', text: block.text }
    if (block.type === 'thinking') {
      return {
        type: 'reasoning',
        text: block.thinking,
        signature: block.signature,
      }
    }
    if (block.type === 'redacted_thinking') {
      return {
        type: 'reasoning',
        text: '',
        signature: block.data,
        metadata: { redacted: true },
        visibility: 'context-only',
      }
    }
    if (block.type === 'tool_use') {
      const argsText = streamedArgs ?? JSON.stringify(block.input ?? {})

      return createToolCall(block.id, block.name, argsText)
    }
    return undefined
  }

  /**
   * 将可能夹带序列化 thinking 的单个原生块展开成公共 Part
   */
  private _parts(block: Anthropic.Messages.ContentBlock, streamedArgs?: string): Part[] {
    if (block.type !== 'text') {
      const part = this._part(block, streamedArgs)

      return part ? [part] : []
    }

    const projection = projectAnthropicText(block.text)

    return [
      ...projection.reasoning,
      ...(projection.text ? [{ type: 'text' as const, text: projection.text }] : []),
    ]
  }

  /**
   * 将 Anthropic Usage 映射为包含总输入的公共 Usage
   */
  private _usage(value: unknown): Usage {
    const raw = rawRecord(value)
    const cacheRead = tokenCount(raw?.cache_read_input_tokens)
      || tokenCount(raw?.prompt_cache_hit_tokens)
    const cacheWrite = tokenCount(raw?.cache_creation_input_tokens)
    const providerInput = tokenCount(raw?.input_tokens)
      || tokenCount(raw?.prompt_cache_miss_tokens)
    const usage = {
      input: providerInput + cacheRead + cacheWrite,
      output: tokenCount(raw?.output_tokens),
      reasoning: tokenCount(raw?.reasoning_tokens),
      cacheRead,
      cacheWrite,
      raw,
    }

    return hasUsage(usage) || Object.keys(raw ?? {}).length > 0 ? usage : EMPTY_USAGE
  }

  /**
   * 标准化 Anthropic 停止原因
   */
  private _finishReason(value: Anthropic.Messages.StopReason | null): FinishReason {
    if (value === 'end_turn' || value === 'stop_sequence')
      return 'completed'
    if (value === 'tool_use')
      return 'tool-calls'
    if (value === 'max_tokens')
      return 'truncated'
    if (value === 'pause_turn')
      return 'paused'
    if (value === 'refusal')
      return 'filtered'
    return 'other'
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 展开 Anthropic 兼容服务偶尔放进 text block 的序列化 thinking
 */
function projectAnthropicText(text: string) {
  const reasoning: Extract<Part, { type: 'reasoning' }>[] = []
  let rest = text

  while (true) {
    const start = rest.match(/^\s*/)?.[0].length ?? 0

    if (rest[start] !== '{')
      break

    const end = findJsonObjectEnd(rest, start)

    if (end < 0)
      break

    const value = parseSerializedThinking(rest.slice(start, end + 1))

    if (!value)
      break

    reasoning.push({
      type: 'reasoning',
      text: value.thinking,
      signature: value.signature,
      metadata: { serialized: true },
      visibility: 'context-only',
    })
    rest = rest.slice(end + 1).trimStart()
  }

  return { reasoning, text: rest }
}

/**
 * 流式阶段只剥离已经完整确认的序列化 thinking 前缀
 */
function stripSerializedThinkingPrefix(text: string, final: boolean): AnthropicTextProjection {
  let rest = text

  while (true) {
    const start = rest.match(/^\s*/)?.[0].length ?? 0

    if (rest[start] !== '{')
      return { pending: false, text: rest }

    const end = findJsonObjectEnd(rest, start)

    if (end < 0)
      return { pending: !final, text: rest }

    if (!parseSerializedThinking(rest.slice(start, end + 1)))
      return { pending: false, text: rest }

    rest = rest.slice(end + 1).trimStart()
    if (!rest)
      return { pending: !final, text: '' }
  }
}

/**
 * 查找字符串中一个完整 JSON 对象的结束位置
 */
function findJsonObjectEnd(text: string, start: number) {
  let depth = 0
  let escaped = false
  let inString = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"')
        inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{')
      depth += 1
    if (char === '}')
      depth -= 1
    if (depth === 0)
      return index
  }

  return -1
}

/**
 * 解析完整的序列化 thinking 对象
 */
function parseSerializedThinking(text: string): {
  signature?: string
  thinking: string
} | undefined {
  try {
    const value: unknown = JSON.parse(text)

    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'thinking')
      return undefined
    if (!('thinking' in value) || typeof value.thinking !== 'string')
      return undefined
    const thinking = value.thinking
    const signature = 'signature' in value ? value.signature : undefined

    if (signature !== undefined && typeof signature !== 'string')
      return undefined

    return {
      thinking,
      ...(typeof signature === 'string' ? { signature } : {}),
    }
  }
  catch {
    return undefined
  }
}

/**
 * 判断供应商是否已经返回非零用量
 */
function hasUsage(usage: Usage) {
  return usage.input > 0 || usage.output > 0 || usage.reasoning > 0
    || usage.cacheRead > 0 || usage.cacheWrite > 0
}
