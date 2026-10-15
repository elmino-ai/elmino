import type { Message, Provider, Request } from '@elmino/llm'
import type { Result } from '@elmino/llm/request'
import type { Event } from '@elmino/llm/stream'
import { extractText } from '@elmino/llm'
import { createToolCall } from '@elmino/llm/adapter'
import { RequestCache } from '@elmino/llm/cache'
import { ObjectParseError } from '@elmino/llm/object'
import { resolveProviderAuth } from '@elmino/llm/provider'
import { EMPTY_USAGE } from '@elmino/llm/usage'

/** 从包根和公开子路径消费模型协议，不访问网络 */
export function verifyModelProtocol(): Request {
  const message: Message = { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }
  const result: Result = { message, usage: EMPTY_USAGE }
  const event: Event = { type: 'usage', usage: result.usage }
  const request: Request = { system: [], messages: [], maxOutputTokens: 10 }

  if (extractText(message) !== 'ok' || event.usage.input !== 0)
    throw new Error('公共协议无法消费')
  if (createToolCall('native-call', 'tool', '{}').invalidArgs)
    throw new Error('工具参数无法解析')
  if (resolveProviderAuth({ model: 'local', apiKeyRequired: false }, 'bearer', 'local').type !== 'none')
    throw new Error('认证策略无法消费')
  RequestCache.create({ cache: { modes: ['disabled'] }, defaultCache: { mode: 'disabled' } }).resolve(request)
  const parseError = new ObjectParseError(result, new Error('expected'))
  if (parseError.result !== result)
    throw new Error('解析错误无法保留模型结果')
  return request
}

/** 用合成 HTTP 响应验证真实 SDK 到公共结果的转换 */
export async function verifyProvider(adapter: Provider, response: object, request: Request) {
  if (adapter.model !== 'local')
    throw new Error('适配器无法装配')
  const client = Reflect.get(adapter, '_client') as { fetch: typeof fetch }

  client.fetch = () => Promise.resolve(new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const generated = await adapter.generate(request)

  if (extractText(generated.message) !== 'ok' || generated.usage.input !== 1)
    throw new Error('打包后的适配器无法通过 SDK 返回公共结果')
}
