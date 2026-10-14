/** 消费模型协议和供应商公开入口，不访问网络 */
export function modelFixture(name) {
  const Adapter = name === 'llm-openai' ? 'ResponsesProvider' : 'AnthropicMessagesProvider'
  return `
import { extractText } from '@elmino/llm'
import type { Message, Provider, Request } from '@elmino/llm'
import { createToolCall } from '@elmino/llm/adapter'
import { RequestCache } from '@elmino/llm/cache'
import { ObjectParseError } from '@elmino/llm/object'
import { resolveProviderAuth } from '@elmino/llm/provider'
import type { Result } from '@elmino/llm/request'
import type { Event } from '@elmino/llm/stream'
import { EMPTY_USAGE } from '@elmino/llm/usage'
${name === 'llm' ? '' : `import { ${Adapter} } from '@elmino/${name}'`}
${name === 'llm-openai'
  ? `import { ChatCompletionsProvider } from '@elmino/llm-openai/chat-completions'
import { ResponsesProvider as Responses } from '@elmino/llm-openai/responses'`
  : ''}
const message: Message = { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }
const result: Result = { message, usage: EMPTY_USAGE }
const event: Event = { type: 'usage', usage: result.usage }
const request: Request = { system: [], messages: [], maxOutputTokens: 10 }
if (extractText(message) !== 'ok' || event.usage.input !== 0) throw new Error('公共协议无法消费')
if (createToolCall('native-call', 'tool', '{}').invalidArgs) throw new Error('工具参数无法解析')
if (resolveProviderAuth({ model: 'local', apiKeyRequired: false }, 'bearer', 'local').type !== 'none')
  throw new Error('认证策略无法消费')
RequestCache.create({ cache: { modes: ['disabled'] }, defaultCache: { mode: 'disabled' } }).resolve(request)
new ObjectParseError(result, new Error('expected'))
${name === 'llm'
  ? `const adapter: Provider | undefined = undefined
if (adapter) throw new Error('协议包不应包含适配器')`
  : `const adapter: Provider = ${Adapter}.create({ model: 'local', apiKeyRequired: false })
if (adapter.model !== 'local') throw new Error('适配器无法装配')
const client = Reflect.get(adapter, '_client') as { fetch: typeof fetch }
const response = ${name === 'llm-openai'
  ? `{ id: 'resp-local', status: 'completed',
output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
usage: { input_tokens: 1, output_tokens: 1,
input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }`
  : `{ id: 'msg-local', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
usage: { input_tokens: 1, output_tokens: 1 } }`}
client.fetch = () => Promise.resolve(new Response(JSON.stringify(response), {
  status: 200, headers: { 'content-type': 'application/json' },
}))
const generated = await adapter.generate(request)
if (extractText(generated.message) !== 'ok' || generated.usage.input !== 1)
  throw new Error('打包后的适配器无法通过 SDK 返回公共结果')`}
${name === 'llm-openai'
  ? `if (Responses !== ResponsesProvider) throw new Error('子路径与根出口不一致')
ChatCompletionsProvider.create({ model: 'local', apiKeyRequired: false })`
  : ''}
`
}
