import type {
  CacheControl,
  EventHandler,
  FinishReason,
  ObjectResult,
  Part,
  Provider,
  ProviderCapabilities,
  Request,
  Result,
  ToolCallPart,
  Usage,
} from '@elmino/llm'
import type { ProviderAuth, ProviderOptions } from '@elmino/llm/provider'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions'
import type { CompletionUsage } from 'openai/resources/completions'
import type { ProviderReuseStrategy } from '../policy/reuse.js'
import type { ChatCompletionsProfile } from './profile.js'
import { parseObject } from '@elmino/llm'
import {
  createAssistantMessage,
  createToolCall,
  createToolCallStart,
  isPlainRecord,
  rawRecord,
  tokenCount,
} from '@elmino/llm/adapter'
import { resolveProviderAuth } from '@elmino/llm/provider'
import OpenAI from 'openai'
import { z } from 'zod'
import { resolveReuse } from '../policy/reuse.js'
import { resolveChatProfile } from './profile.js'

/** -------------------- 类型 -------------------- */
/** OpenAI Chat Completions 适配器配置 */
interface ChatCompletionsProviderContext {
  /** OpenAI 兼容接口地址 */
  baseURL?: string
  /** Provider 工厂已经解析的内部认证策略 */
  auth: ProviderAuth
  /** Provider 原生模型名 */
  model: string
  /** 模型是否支持原生 JSON Schema */
  jsonSchema?: boolean
  /** Provider 稳定名称 */
  providerName: string
  /** 当前供应商与 Chat Completions 协议的请求复用策略 */
  reuse: ProviderReuseStrategy
  /** 私有协议差异 */
  profile: ChatCompletionsProfile
}

/** OpenAI Chat Completions 扩展请求 */
type OpenAIChatRequest = ChatCompletionCreateParamsNonStreaming & Record<string, unknown>

/** Chat Completions 流式工具调用草稿 */
interface OpenAIChatToolDraft {
  /** Provider 工具调用 ID */
  id: string
  /** 工具名称 */
  name: string
  /** 累计 JSON 参数 */
  args: string
  /** 是否已经发布稳定工具身份 */
  started: boolean
}

/** -------------------- 核心类 -------------------- */
/**
 * 将 OpenAI Chat Completions 协议投影为项目统一 Provider
 */
export class ChatCompletionsProvider implements Provider {
  /** Provider 稳定名称 */
  public readonly name: string
  /** Provider 原生模型名 */
  public readonly model: string
  /** 当前模型能力 */
  public readonly capabilities: ProviderCapabilities

  /** OpenAI 兼容 SDK 客户端 */
  private readonly _client: OpenAI
  /** 当前供应商的内部协议差异 */
  private readonly _profile: ChatCompletionsProfile
  /** 当前供应商与 Chat Completions 协议的请求复用策略 */
  private readonly _reuse: ProviderReuseStrategy

  /**
   * 创建单一 Chat Completions 适配器并解析模型 Profile
   */
  public static create(config: ProviderOptions) {
    const { baseURL, jsonSchema, model, providerName = 'openai', cache = { mode: 'automatic' } } = config
    const auth = resolveProviderAuth(config, 'bearer', providerName)
    const reuse = resolveReuse('chat-completions', cache, providerName)
    const profile = resolveChatProfile({ model, providerName })
    const context: ChatCompletionsProviderContext = {
      auth,
      baseURL,
      jsonSchema,
      model,
      profile,
      providerName,
      reuse,
    }

    return new ChatCompletionsProvider(context)
  }

  /**
   * 保存 Provider 模型与私有协议差异
   */
  private constructor(config: ChatCompletionsProviderContext) {
    const {
      auth,
      baseURL,
      jsonSchema = true,
      model,
      profile,
      providerName,
      reuse,
    } = config
    const apiKey = auth.type === 'bearer' ? auth.credential : 'not-required'
    const defaultHeaders = auth.type === 'none'
      ? { Authorization: null }
      : auth.type === 'api-key'
        ? { 'Authorization': null, 'X-Api-Key': auth.credential }
        : undefined

    this.name = providerName
    this.model = model
    this._profile = profile
    this._reuse = reuse
    this.capabilities = {
      cache: reuse.cache,
      reasoning: true,
      tools: true,
      jsonSchema,
    }
    this._client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders,
    })
  }

  /** -------------------- 核心方法 -------------------- */
  /**
   * 非流式生成完整消息
   */
  public async generate(request: Request): Promise<Result> {
    const input = this._request(request)
    const response = await this._client.chat.completions.create(
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
    const body = {
      ...this._createBody(input),
      ...this._profile.streaming,
      stream: true,
      stream_options: { include_usage: true },
    } satisfies ChatCompletionCreateParamsStreaming
    const stream = await this._client.chat.completions.create(body, { signal: input.signal })
    const tools = new Map<number, OpenAIChatToolDraft>()
    const toolNames = input.tools?.map(tool => tool.name) ?? []
    const parts: Part[] = []
    let responseId: string | undefined
    let text = ''
    let reasoning = ''
    let rawFinishReason: string | null = null
    let usage: Usage = this._usage()

    for await (const chunk of stream) {
      if (!responseId)
        responseId = chunk.id

      if (chunk.usage) {
        usage = this._usage(chunk.usage)
        await onEvent?.({ type: 'usage', usage })
      }

      const choice = chunk.choices[0]

      if (!choice)
        continue
      const rawChoice = choice as unknown as Record<string, unknown>
      const choiceUsage = isPlainRecord(rawChoice.usage)
        ? rawChoice.usage
        : undefined

      // Moonshot 的流式 usage 可能位于 choices[0]，需要与标准顶层字段合并处理
      if (choiceUsage) {
        usage = this._usage(choiceUsage as unknown as CompletionUsage)
        await onEvent?.({ type: 'usage', usage })
      }
      rawFinishReason = choice.finish_reason ?? rawFinishReason
      const delta = choice.delta
      const textDelta = delta.content ?? ''
      const rawDelta = delta as unknown as Record<string, unknown>
      const reasoningDelta = typeof rawDelta.reasoning_content === 'string'
        ? rawDelta.reasoning_content
        : typeof rawDelta.reasoning === 'string' ? rawDelta.reasoning : ''

      if (textDelta) {
        if (!text) {
          await onEvent?.({
            type: 'part-start',
            index: 0,
            part: { type: 'text', text: '' },
          })
        }
        text += textDelta
        await onEvent?.({
          type: 'part-delta',
          index: 0,
          delta: { type: 'text', text: textDelta },
        })
      }

      if (reasoningDelta) {
        if (!reasoning) {
          await onEvent?.({
            type: 'part-start',
            index: 1,
            part: { type: 'reasoning', text: '' },
          })
        }
        reasoning += reasoningDelta
        await onEvent?.({
          type: 'part-delta',
          index: 1,
          delta: { type: 'reasoning', text: reasoningDelta },
        })
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index
        const draft = tools.get(index) ?? {
          id: '',
          name: '',
          args: '',
          started: false,
        }

        tools.set(index, draft)
        draft.id = call.id ?? draft.id
        const nameDelta = call.function?.name ?? ''
        const argsDelta = call.function?.arguments ?? ''

        draft.name += nameDelta
        draft.args += argsDelta
        // Chat 没有工具名结束事件，只有精确命中请求工具后才固定投影身份
        const stableName = toolNames.includes(draft.name)
          && !toolNames.some(name => name !== draft.name && name.startsWith(draft.name))

        if (!draft.started && draft.id && stableName && draft.args) {
          draft.started = true
          await onEvent?.({
            type: 'part-start',
            index: index + 2,
            part: createToolCallStart(draft.id, draft.name),
          })
          await onEvent?.({
            type: 'part-delta',
            index: index + 2,
            delta: { type: 'tool-args', text: draft.args },
          })
        }
        else if (draft.started && argsDelta) {
          await onEvent?.({
            type: 'part-delta',
            index: index + 2,
            delta: { type: 'tool-args', text: argsDelta },
          })
        }
      }
    }

    if (reasoning) {
      const part = { type: 'reasoning' as const, text: reasoning }

      parts.push(part)
      await onEvent?.({ type: 'part-end', index: 1, part })
    }
    if (text) {
      const part = { type: 'text' as const, text }

      parts.push(part)
      await onEvent?.({ type: 'part-end', index: 0, part })
    }
    for (const [index, draft] of tools) {
      const id = draft.id || `call_${index}`

      if (!draft.started) {
        await onEvent?.({
          type: 'part-start',
          index: index + 2,
          part: createToolCallStart(id, draft.name),
        })
        if (draft.args) {
          await onEvent?.({
            type: 'part-delta',
            index: index + 2,
            delta: { type: 'tool-args', text: draft.args },
          })
        }
      }
      const part = createToolCall(id, draft.name, draft.args)

      parts.push(part)
      await onEvent?.({ type: 'part-end', index: index + 2, part })
    }

    const finishReason = this._finishReason(rawFinishReason)
    const message = createAssistantMessage({
      id: responseId,
      parts,
      finishReason,
      rawFinishReason,
    })

    return { message, usage }
  }

  /**
   * 使用原生 JSON Schema 或纯 JSON 指令生成结构化对象
   */
  public async generateObject<TSchema extends z.ZodType>(
    request: Omit<Request, 'responseFormat'> & { schema: TSchema, schemaName?: string },
  ): Promise<ObjectResult<TSchema>> {
    const { schema, schemaName = 'response', ...input } = request
    const jsonSchema = z.toJSONSchema(schema) as unknown as Record<string, unknown>
    const nativeJsonSchema = this.capabilities.jsonSchema
    const nativeJsonObject = this._profile.structuredOutput === 'json-object'
    const result = await this.generate({
      ...input,
      system: nativeJsonSchema
        ? input.system
        : [
            ...input.system,
            { type: 'text', text: `仅返回符合以下 JSON Schema 的 JSON：\n${JSON.stringify(jsonSchema)}` },
          ],
      responseFormat: nativeJsonSchema || nativeJsonObject
        ? { type: 'json-schema', name: schemaName, schema: jsonSchema }
        : undefined,
      // 结构化输出不继承调用方的思考配置，由 Profile 选择关闭或最低档
      reasoning: 'disabled',
    })

    return parseObject(result, schema)
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 应用供应商内部缓存策略并校验可选覆盖
   */
  private _request(request: Request): Request & { cache: CacheControl } {
    return this._reuse.resolve(request)
  }

  /**
   * 创建 OpenAI Chat Completions 请求
   */
  private _createBody(request: Request & { cache: CacheControl }): OpenAIChatRequest {
    const maxOutput = {
      [this._profile.maxOutputField]: request.maxOutputTokens,
    }
    const reasoning = request.reasoning === 'disabled'
      ? this._profile.disabledReasoning
      : { ...this._profile.reasoning, ...request.reasoning }
    const body: OpenAIChatRequest = {
      model: this.model,
      messages: this._messages(request),
      ...maxOutput,
      temperature: request.temperature,
      top_p: request.topP,
      tools: request.tools?.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: this._profile.normalizeToolSchema
            ? this._profile.normalizeToolSchema(tool.schema)
            : tool.schema,
        },
      })),
      response_format: request.responseFormat
        ? this._profile.structuredOutput === 'json-object'
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              json_schema: {
                name: request.responseFormat.name,
                schema: request.responseFormat.schema,
                strict: true,
              },
            }
        : undefined,
      prompt_cache_key: this._reuse.promptCacheKey
        ? request.cacheKey
        : undefined,
      ...reasoning,
    }

    return body
  }

  /**
   * 将公共消息映射为 Chat Completions 消息
   */
  private _messages(request: Request & { cache: CacheControl }): ChatCompletionMessageParam[] {
    const breakpoints = new Set(request.cache.breakpoints)
    const system = request.system.map(part => part.text).join('\n\n')
    const messages: unknown[] = system
      ? [{
          role: 'system',
          content: request.cache.mode === 'explicit' && breakpoints.has('system')
            ? [{
                type: 'text',
                text: system,
                cache_control: { type: 'ephemeral' },
              }]
            : system,
        }]
      : []
    const latestUser = request.messages.findLastIndex(message => (
      message.role === 'user' || message.role === 'tool'
    ))

    for (const [index, message] of request.messages.entries()) {
      if (message.role === 'tool') {
        const results = message.parts.filter(part => part.type === 'tool-result')

        for (const [resultIndex, part] of results.entries()) {
          const text = typeof part.result === 'string'
            ? part.result
            : part.result.map(item => item.type === 'text' ? item.text : item.data).join('\n')
          const shouldMark = request.cache.mode === 'explicit'
            && breakpoints.has('latest-user')
            && index === latestUser
            && resultIndex === results.length - 1

          messages.push({
            role: 'tool',
            tool_call_id: part.callId,
            content: shouldMark
              ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
              : text,
          })
        }
        continue
      }

      const text = message.parts
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')
      const content = message.role === 'user'
        ? message.parts
            .filter(part => part.type === 'text' || part.type === 'image')
            .map((part) => {
              if (part.type === 'text') {
                return {
                  type: 'text',
                  text: part.text,
                }
              }

              return {
                type: 'image_url',
                image_url: {
                  url: part.data.startsWith('data:') || part.data.startsWith('http')
                    ? part.data
                    : `data:${part.mime};base64,${part.data}`,
                },
              }
            })
        : text
      const shouldMark = request.cache.mode === 'explicit'
        && breakpoints.has('latest-user')
        && index === latestUser

      if (shouldMark && Array.isArray(content)) {
        const lastText = content.findLastIndex(part => part.type === 'text')

        if (lastText >= 0)
          Object.assign(content[lastText]!, { cache_control: { type: 'ephemeral' } })
      }
      const toolCalls = message.parts
        .filter((part): part is ToolCallPart => part.type === 'tool-call')
        .map(part => ({
          id: part.id,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.argsText ?? JSON.stringify(part.args),
          },
        }))
      const reasoning = message.parts
        .filter(part => part.type === 'reasoning')
        .map(part => part.text)
        .join('\n')

      messages.push({
        role: message.role,
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning || (this._profile.preserveThinking && message.role === 'assistant')
          ? { reasoning_content: reasoning }
          : {}),
      })
    }

    return messages as ChatCompletionMessageParam[]
  }

  /**
   * 将完整响应映射为公共结果
   */
  private _result(response: ChatCompletion): Result {
    const choice = response.choices[0]

    if (!choice)
      throw new Error(`${this.name} 响应没有候选消息`)

    const parts = this._parts(choice.message)
    const finishReason = this._finishReason(choice.finish_reason)
    const metadata = rawRecord({ model: response.model })

    return {
      message: createAssistantMessage({
        id: response.id,
        parts,
        finishReason,
        rawFinishReason: choice.finish_reason,
        metadata,
      }),
      usage: this._usage(response.usage),
    }
  }

  /**
   * 将 assistant 消息映射成公共 Part
   */
  private _parts(message: ChatCompletionMessage): Part[] {
    const raw = message as unknown as Record<string, unknown>
    const reasoning = typeof raw.reasoning_content === 'string'
      ? raw.reasoning_content
      : typeof raw.reasoning === 'string' ? raw.reasoning : ''
    const parts: Part[] = []

    if (reasoning)
      parts.push({ type: 'reasoning', text: reasoning })
    if (message.content)
      parts.push({ type: 'text', text: message.content })
    for (const call of message.tool_calls ?? []) {
      if (call.type === 'function')
        parts.push(createToolCall(call.id, call.function.name, call.function.arguments))
    }

    return parts
  }

  /**
   * 映射 Usage 的缓存读写和推理细分
   */
  private _usage(value?: CompletionUsage | null): Usage {
    const raw = rawRecord(value)
    const details = isPlainRecord(raw?.prompt_tokens_details)
      ? raw.prompt_tokens_details
      : undefined
    const outputDetails = isPlainRecord(raw?.completion_tokens_details)
      ? raw.completion_tokens_details
      : undefined

    return {
      input: tokenCount(raw?.prompt_tokens),
      output: tokenCount(raw?.completion_tokens),
      reasoning: tokenCount(outputDetails?.reasoning_tokens),
      cacheRead: tokenCount(details?.cached_tokens),
      cacheWrite: tokenCount(details?.cache_creation_input_tokens)
        || tokenCount(details?.cache_write_tokens),
      raw,
    }
  }

  /**
   * 标准化 Chat Completions 结束原因
   */
  private _finishReason(value: string | null): FinishReason {
    if (value === 'length')
      return 'truncated'
    if (value === 'content_filter')
      return 'filtered'
    if (value === 'tool_calls')
      return 'tool-calls'
    if (value === 'stop')
      return 'completed'

    return 'other'
  }
}
