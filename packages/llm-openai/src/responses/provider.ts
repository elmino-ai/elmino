import type {
  CacheControl,
  EventHandler,
  FinishReason,
  Message,
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
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputItem,
  ResponseUsage,
} from 'openai/resources/responses/responses'
import type { ProviderReuseStrategy } from '../policy/reuse.js'
import { parseObject } from '@elmino/llm'
import { createAssistantMessage, createToolCall, createToolCallStart, rawRecord, tokenCount } from '@elmino/llm/adapter'
import { resolveProviderAuth } from '@elmino/llm/provider'
import { deepEqual } from '@elmino/shared'
import OpenAI from 'openai'
import { z } from 'zod'
import { resolveReuse } from '../policy/reuse.js'

/** -------------------- 类型 -------------------- */
/** OpenAI Responses 适配器配置 */
interface ResponsesProviderContext {
  /** OpenAI 兼容 Responses 地址 */
  baseURL?: string
  /** Provider 工厂已经解析的内部认证策略 */
  auth: ProviderAuth
  /** Provider 原生模型名 */
  model: string
  /** 模型是否支持原生 JSON Schema */
  jsonSchema?: boolean
  /** Provider 稳定名称 */
  providerName: string
  /** 当前供应商与 Responses 协议的请求复用策略 */
  reuse: ProviderReuseStrategy
}

/** OpenAI Responses 公共请求基础对象 */
type OpenAIRequest = Omit<ResponseCreateParamsNonStreaming, 'stream'>

/** 单个 Responses Provider 实例内可继续追加的服务端会话 */
interface ResponsesSession {
  /** 上一次成功响应的原生 ID */
  responseId: string
  /** 已由服务端保存的完整消息前缀 */
  messages: Message[]
  /** 已由服务端保存的稳定系统提示 */
  system: Request['system']
}

/** 已完成会话匹配的单次 Responses 请求 */
interface PreparedResponsesRequest {
  /** 发送给 SDK 的原生请求 */
  body: OpenAIRequest
  /** 应用模型默认值后的公共请求 */
  request: Request & { cache: CacheControl }
  /** 可写回会话状态的线程级路由键 */
  sessionKey?: string
}

/** -------------------- 核心类 -------------------- */
/**
 * 将 OpenAI Responses API 投影为项目统一 Provider
 */
export class ResponsesProvider implements Provider {
  /** Provider 稳定名称 */
  public readonly name: string
  /** Provider 原生模型名 */
  public readonly model: string
  /** 当前模型能力 */
  public readonly capabilities: ProviderCapabilities

  /** OpenAI SDK 客户端 */
  private readonly _client: OpenAI
  /** 当前供应商与 Responses 协议的请求复用策略 */
  private readonly _reuse: ProviderReuseStrategy
  /** 当前适配器实例内按稳定路由键保存的 Responses 服务端会话 */
  private readonly _sessions = new Map<string, ResponsesSession>()
  /**
   * 创建 OpenAI Responses Provider
   */
  public static create(config: ProviderOptions) {
    const { baseURL, jsonSchema, model, providerName = 'openai', cache = { mode: 'automatic' } } = config
    const auth = resolveProviderAuth(config, 'bearer', providerName)
    const reuse = resolveReuse('responses', cache, providerName)

    return new ResponsesProvider({ auth, baseURL, jsonSchema, model, providerName, reuse })
  }

  /**
   * 保存已经解析的 OpenAI 模型和缓存能力
   */
  private constructor(config: ResponsesProviderContext) {
    const { auth, baseURL, jsonSchema = true, model, providerName, reuse } = config
    const apiKey = auth.type === 'bearer' ? auth.credential : 'not-required'
    const defaultHeaders = auth.type === 'none'
      ? { Authorization: null }
      : auth.type === 'api-key'
        ? { 'Authorization': null, 'X-Api-Key': auth.credential }
        : undefined

    this.name = providerName
    this.model = model
    this.capabilities = {
      cache: reuse.cache,
      reasoning: true,
      tools: true,
      jsonSchema,
    }
    this._reuse = reuse
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
    const prepared = this._prepare(request)
    const response = await this._client.responses.create(
      prepared.body,
      this._options(prepared.request),
    )
    const result = this._result(response)

    this._commitSession(prepared, response, result)
    return result
  }

  /**
   * 流式生成并投影统一 Event
   */
  public async stream(request: Request, onEvent?: EventHandler): Promise<Result> {
    const prepared = this._prepare(request)
    const body = { ...prepared.body, stream: true } satisfies ResponseCreateParamsStreaming
    const stream = await this._client.responses.create(body, this._options(prepared.request))
    const started = new Set<number>()
    let completed: OpenAIResponse | undefined

    for await (const event of stream) {
      if (event.type === 'response.output_item.added') {
        const initialArgs = event.item.type === 'function_call'
          ? event.item.arguments
          : ''
        const part = event.item.type === 'function_call'
          ? createToolCallStart(event.item.call_id, event.item.name)
          : event.item.type === 'reasoning'
            ? { type: 'reasoning' as const, text: '' }
            : event.item.type === 'message'
              ? { type: 'text' as const, text: '' }
              : undefined

        if (!part)
          continue
        started.add(event.output_index)
        await onEvent?.({
          type: 'part-start',
          index: event.output_index,
          part,
        })
        if (initialArgs) {
          await onEvent?.({
            type: 'part-delta',
            index: event.output_index,
            delta: { type: 'tool-args', text: initialArgs },
          })
        }
        continue
      }

      if (event.type === 'response.output_text.delta') {
        if (!started.has(event.output_index)) {
          started.add(event.output_index)
          await onEvent?.({
            type: 'part-start',
            index: event.output_index,
            part: { type: 'text', text: '' },
          })
        }
        await onEvent?.({
          type: 'part-delta',
          index: event.output_index,
          delta: { type: 'text', text: event.delta },
        })
        continue
      }

      if (
        event.type === 'response.reasoning_text.delta'
        || event.type === 'response.reasoning_summary_text.delta'
      ) {
        if (!started.has(event.output_index)) {
          started.add(event.output_index)
          await onEvent?.({
            type: 'part-start',
            index: event.output_index,
            part: { type: 'reasoning', text: '' },
          })
        }
        await onEvent?.({
          type: 'part-delta',
          index: event.output_index,
          delta: { type: 'reasoning', text: event.delta },
        })
        continue
      }

      if (event.type === 'response.function_call_arguments.delta') {
        await onEvent?.({
          type: 'part-delta',
          index: event.output_index,
          delta: { type: 'tool-args', text: event.delta },
        })
        continue
      }

      if (event.type === 'response.function_call_arguments.done')
        continue

      if (
        event.type === 'response.output_text.done'
        || event.type === 'response.reasoning_text.done'
        || event.type === 'response.reasoning_summary_text.done'
      ) {
        continue
      }

      if (event.type === 'response.output_item.done') {
        const parts = this._parts(event.item)
        const part = event.item.type === 'message'
          ? { type: 'text' as const, text: parts.map(part => part.type === 'text' ? part.text : '').join('') }
          : parts[0]

        if (!part)
          continue
        if (!started.has(event.output_index)) {
          await onEvent?.({
            type: 'part-start',
            index: event.output_index,
            part: part.type === 'text'
              ? { type: 'text', text: '' }
              : part.type === 'reasoning'
                ? { type: 'reasoning', text: '' }
                : part.type === 'tool-call'
                  ? createToolCallStart(part.id, part.name, part.metadata)
                  : part,
          })
        }
        await onEvent?.({ type: 'part-end', index: event.output_index, part })
        continue
      }

      if (
        event.type === 'response.completed'
        || event.type === 'response.incomplete'
      ) {
        completed = event.response
        continue
      }
      if (event.type === 'response.failed')
        throw new Error(event.response.error?.message ?? 'OpenAI 响应失败')
      if (event.type === 'error')
        throw new Error(event.message)
    }

    if (!completed)
      throw new Error('OpenAI 流未返回完成响应')

    const result = this._result(completed)

    this._commitSession(prepared, completed, result)
    await onEvent?.({ type: 'usage', usage: result.usage })
    return result
  }

  /**
   * 使用 Responses JSON Schema 生成结构化对象
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
      // OpenAI reasoning 模型省略 effort 时会采用模型默认值，必须显式关闭
      reasoning: 'disabled',
    })

    return parseObject(result, schema)
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 应用 OpenAI 适配器内部缓存策略并校验可选覆盖
   */
  private _request(request: Request): Request & { cache: CacheControl } {
    return this._reuse.resolve(request)
  }

  /**
   * 只在公共历史严格追加时续接服务端会话，否则发送完整投影重建会话
   */
  private _prepare(request: Request): PreparedResponsesRequest {
    const input = this._request(request)
    const sessionKey = input.cache.mode !== 'disabled'
      && input.cacheKey
      && this._reuse.responseSession
      ? `${this._reuse.responseSession}:${input.cacheKey}`
      : undefined
    const session = sessionKey ? this._sessions.get(sessionKey) : undefined
    const continuation = session
      && deepEqual(input.system, session.system)
      && messagesStartWith(input.messages, session.messages)
      ? session
      : undefined
    const projected = continuation
      ? {
          ...input,
          messages: input.messages.slice(continuation.messages.length),
          system: [],
        }
      : input
    const body = this._createBody(projected)

    if (continuation)
      body.previous_response_id = continuation.responseId

    return { body, request: input, sessionKey }
  }

  /**
   * 为百炼 Responses 的官方 Session Cache 添加请求级开关
   */
  private _options(request: Request & { cache: CacheControl }) {
    return {
      signal: request.signal,
      headers: request.cache.mode !== 'disabled' && this._reuse.responseSession === 'bailian'
        ? { 'x-dashscope-session-cache': 'enable' }
        : undefined,
    }
  }

  /**
   * 仅在响应成功投影后推进与公共历史一一对应的服务端会话
   */
  private _commitSession(
    prepared: PreparedResponsesRequest,
    response: OpenAIResponse,
    result: Result,
  ) {
    const { request, sessionKey } = prepared

    if (!sessionKey || response.status !== 'completed')
      return

    this._sessions.set(sessionKey, {
      responseId: response.id,
      messages: structuredClone([...request.messages, result.message]),
      system: structuredClone(request.system),
    })
  }

  /**
   * 创建 OpenAI Responses 原生请求
   */
  private _createBody(request: Request & { cache: CacheControl }): OpenAIRequest {
    const { cache, responseFormat } = request
    const input = this._input(request)
    const body: OpenAIRequest = {
      model: this.model,
      input,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      tools: request.tools?.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
        strict: false,
      })),
      reasoning: request.reasoning === 'disabled'
        ? { effort: 'none' }
        : request.reasoning,
      text: responseFormat
        ? {
            format: {
              type: 'json_schema',
              name: responseFormat.name,
              schema: responseFormat.schema,
              strict: true,
            },
          }
        : undefined,
      prompt_cache_key: this._reuse.promptCacheKey
        ? request.cacheKey
        : undefined,
    }

    if (cache.mode !== 'disabled' && this._reuse.automaticControl) {
      // OpenAI Responses 的缓存协议与保留时间都属于适配器实现细节
      body.prompt_cache_options = {
        mode: cache.mode === 'explicit' ? 'explicit' : 'implicit',
        ttl: '30m',
      }
    }

    return body
  }

  /**
   * 将公共系统提示词和消息历史映射为 Responses 输入项
   */
  private _input(request: Request & { cache: CacheControl }): ResponseInput {
    const breakpoints = new Set(request.cache.breakpoints)
    const systemContent = request.system.map((part, index) => ({
      type: 'input_text' as const,
      text: part.text,
      ...(request.cache.mode === 'explicit'
        && breakpoints.has('system')
        && index === request.system.length - 1
        ? { prompt_cache_breakpoint: { mode: 'explicit' as const } }
        : {}),
    }))
    const input: unknown[] = systemContent.length > 0
      ? [{ role: 'system', content: systemContent }]
      : []
    const latestUser = request.messages.findLastIndex(message => (
      message.role === 'user' || message.role === 'tool'
    ))

    for (const [messageIndex, message] of request.messages.entries()) {
      const shouldMark = request.cache.mode === 'explicit'
        && breakpoints.has('latest-user')
        && messageIndex === latestUser
      const lastContent = message.parts.findLastIndex(part => (
        part.type !== 'reasoning' && part.type !== 'tool-call' && part.type !== 'tool-result'
      ))
      const lastToolResult = message.parts.findLastIndex(part => part.type === 'tool-result')
      let content: Record<string, unknown>[] = []

      /** 按原始 Part 顺序提交相邻普通内容，避免跨 reasoning 或工具项重排 */
      const flushContent = () => {
        if (content.length === 0)
          return

        input.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content,
        })
        content = []
      }

      for (const [partIndex, part] of message.parts.entries()) {
        if (part.type !== 'reasoning' && part.type !== 'tool-call' && part.type !== 'tool-result') {
          const item = part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : part.type === 'image'
              ? {
                  type: 'input_image',
                  image_url: part.data.startsWith('data:') || part.data.startsWith('http')
                    ? part.data
                    : `data:${part.mime};base64,${part.data}`,
                }
              : {
                  type: 'input_file',
                  file_data: part.data,
                  filename: part.name,
                }

          if (shouldMark && partIndex === lastContent) {
            Object.assign(item, {
              prompt_cache_breakpoint: { mode: 'explicit' },
            })
          }
          content.push(item)
          continue
        }

        flushContent()

        if (part.type === 'reasoning' && part.signature) {
          const metadataId = part.metadata?.id

          input.push({
            type: 'reasoning',
            id: typeof metadataId === 'string'
              ? metadataId
              : message.id ?? `reasoning_${messageIndex}_${partIndex}`,
            encrypted_content: part.signature,
            summary: part.text ? [{ type: 'summary_text', text: part.text }] : [],
          })
        }
        else if (part.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: part.argsText ?? JSON.stringify(part.args),
          })
        }
        else if (part.type === 'tool-result') {
          const markOutput = shouldMark && partIndex === lastToolResult
          const output = typeof part.result === 'string'
            ? markOutput
              ? [{
                  type: 'input_text' as const,
                  text: part.result,
                  prompt_cache_breakpoint: { mode: 'explicit' as const },
                }]
              : part.result
            : part.result.map(item => item.type === 'text'
                ? { type: 'input_text' as const, text: item.text }
                : item.type === 'image'
                  ? {
                      type: 'input_image' as const,
                      detail: 'auto' as const,
                      image_url: item.data.startsWith('data:') || item.data.startsWith('http')
                        ? item.data
                        : `data:${item.mime};base64,${item.data}`,
                    }
                  : { type: 'input_file' as const, file_data: item.data, filename: item.name })

          if (markOutput && Array.isArray(output) && output.length > 0) {
            Object.assign(output[output.length - 1]!, {
              prompt_cache_breakpoint: { mode: 'explicit' },
            })
          }
          input.push({
            type: 'function_call_output',
            call_id: part.callId,
            output,
          })
        }
      }

      flushContent()
    }

    return input as ResponseInput
  }

  /**
   * 将 OpenAI Responses 完整响应映射为公共结果
   */
  private _result(response: OpenAIResponse): Result {
    const parts = response.output.flatMap(item => this._parts(item))
    const finishReason = this._finishReason(response, parts)
    const rawFinishReason = response.incomplete_details?.reason ?? response.status
    const metadata = rawRecord({
      error: response.error,
      model: response.model,
    })

    return {
      message: createAssistantMessage({
        id: response.id,
        parts,
        finishReason,
        rawFinishReason,
        metadata,
      }),
      usage: this._usage(response.usage),
    }
  }

  /**
   * 将单个 Responses 输出项映射为公共 Part
   */
  private _parts(item: ResponseOutputItem): Part[] {
    if (item.type === 'message') {
      return item.content.map((content) => {
        if (content.type === 'output_text')
          return { type: 'text', text: content.text } satisfies Part

        return { type: 'text', text: content.refusal } satisfies Part
      })
    }
    if (item.type === 'reasoning') {
      const text = [...item.summary, ...(item.content ?? [])]
        .map(content => content.text)
        .filter(Boolean)
        .join('\n')

      return [{
        type: 'reasoning',
        text,
        signature: item.encrypted_content ?? undefined,
        metadata: { id: item.id },
      }]
    }
    if (item.type === 'function_call') {
      return [createToolCall(
        item.call_id,
        item.name,
        item.arguments,
        rawRecord({ id: item.id, namespace: item.namespace }),
      )]
    }

    return []
  }

  /**
   * 映射 OpenAI Usage
   */
  private _usage(value: ResponseUsage | null | undefined): Usage {
    return {
      input: tokenCount(value?.input_tokens),
      output: tokenCount(value?.output_tokens),
      reasoning: tokenCount(value?.output_tokens_details.reasoning_tokens),
      cacheRead: tokenCount(value?.input_tokens_details.cached_tokens),
      cacheWrite: tokenCount(value?.input_tokens_details.cache_write_tokens),
      raw: rawRecord(value),
    }
  }

  /**
   * 标准化 Responses 结束原因
   */
  private _finishReason(response: OpenAIResponse, parts: Part[]): FinishReason {
    if (response.status === 'failed')
      return 'error'
    if (response.status === 'incomplete') {
      return response.incomplete_details?.reason === 'max_output_tokens'
        ? 'truncated'
        : 'other'
    }
    if (parts.some((part): part is ToolCallPart => part.type === 'tool-call'))
      return 'tool-calls'

    return 'completed'
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 判断当前 Provider 历史是否严格保留了服务端会话中的消息前缀
 */
function messagesStartWith(messages: Message[], prefix: Message[]) {
  return messages.length >= prefix.length
    && deepEqual(messages.slice(0, prefix.length), prefix)
}
