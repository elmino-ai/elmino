import type { CachePolicy, Provider, Request } from '@elmino/llm'
import type { ProviderOptions } from '@elmino/llm/provider'
import { ChatCompletionsProvider } from '@elmino/llm-openai'

/** -------------------- 类型 -------------------- */
/** 测试替身捕获的 Provider 原生请求 */
export interface CapturedRequest {
  /** 最近一次原生请求体 */
  body?: Record<string, unknown>
}

/** -------------------- 常量 -------------------- */
/** 三类 Provider 共用的统一请求 */
export const request: Request = {
  system: [{ type: 'text', text: '稳定系统提示' }],
  messages: [{
    role: 'user',
    parts: [{ type: 'text', text: '读取天气' }],
  }],
  tools: [{
    name: 'weather',
    description: '读取天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
  maxOutputTokens: 1024,
}

/** 显式缓存的具体断点由供应商和消息协议策略决定 */
export const explicitCache = { mode: 'explicit' } satisfies CachePolicy

/** 仅依赖供应商自动前缀复用的测试模型缓存配置 */
export const automaticCache = { mode: 'automatic' } satisfies CachePolicy

/** BigModel Coding Plan 官方 OpenAI-compatible 端点 */
const BIGMODEL_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'

/**
 * 创建百炼 Chat Profile 测试实例
 */
export function createBailianChat(
  config: ProviderOptions,
) {
  const providerName = config.providerName ?? 'aliyun-bailian'

  return ChatCompletionsProvider.create({ ...config, providerName })
}

/**
 * 将 SDK 客户端替换为只在测试中使用的内存替身
 */
export function injectClient(provider: Provider, client: object) {
  Reflect.set(provider, '_client', client)
}

/**
 * 捕获原生请求体并返回固定响应
 */
export function captureCreate(captured: CapturedRequest, response: object) {
  return (body: Record<string, unknown>) => {
    captured.body = body
    return Promise.resolve(response)
  }
}

/**
 * 通过真实 SDK 请求构建过程捕获最终网络请求头
 */
export async function captureRequestHeaders(provider: Provider, response: object) {
  let headers: Headers | undefined
  const client = (provider as unknown as {
    /** Provider SDK 客户端 */
    _client: { fetch: typeof fetch }
  })._client

  client.fetch = (_url, init) => {
    headers = new Headers(init?.headers)
    return Promise.resolve(new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }))
  }
  await provider.generate(request)

  if (!headers)
    throw new Error('Provider SDK 未发送请求')
  return headers
}

/**
 * 创建 OpenAI Responses 完整响应
 */
export function openAIResponse() {
  return {
    id: 'resp_openai',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'gpt-5.6',
    error: null,
    incomplete_details: null,
    instructions: null,
    output_text: '我来查询。',
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    output: [
      {
        type: 'reasoning',
        id: 'reasoning_openai',
        encrypted_content: 'encrypted-reasoning',
        summary: [{ type: 'summary_text', text: '先查天气' }],
        content: [],
        status: 'completed',
      },
      {
        type: 'message',
        id: 'message_openai',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '我来查询。', annotations: [], logprobs: [] }],
      },
      {
        type: 'function_call',
        id: 'item_openai',
        call_id: 'call_openai',
        name: 'weather',
        arguments: '{"city":"杭州"}',
        status: 'completed',
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120,
    },
  }
}

/**
 * 创建阿里云百炼 Chat Completions 完整响应
 */
export function qwenResponse() {
  return {
    id: 'chatcmpl_qwen',
    object: 'chat.completion',
    created: 0,
    model: 'qwen3.7-plus',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      logprobs: null,
      message: {
        role: 'assistant',
        content: '我来查询。',
        reasoning_content: '先查天气',
        refusal: null,
        annotations: [],
        tool_calls: [{
          id: 'call_qwen',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"杭州"}' },
        }],
      },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  }
}

/**
 * 创建可选择在末尾抛错的异步事件序列
 */
export function asyncIterable<T>(items: T[], error?: Error) {
  return {
    async* [Symbol.asyncIterator]() {
      for (const item of items)
        yield item
      if (error)
        throw error
    },
  }
}

/**
 * 通过公共工厂创建 BigModel Coding Plan Provider
 */
export function createBigModelProvider(model: string, credential = 'test-key') {
  return ChatCompletionsProvider.create({
    credential,
    providerName: 'bigmodel-coding-plan',
    baseURL: BIGMODEL_CODING_BASE_URL,
    cache: { mode: 'automatic' },
    jsonSchema: false,
    model,
  })
}

/**
 * 创建具有思考和缓存用量的 Chat Completions 完整响应
 */
export function createBigModelResponse(content = '我来查询。') {
  return {
    id: 'chatcmpl_bigmodel',
    object: 'chat.completion',
    created: 0,
    model: 'glm-5.3',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: {
        role: 'assistant',
        content,
        reasoning_content: '先查天气',
        refusal: null,
        annotations: [],
      },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  }
}
