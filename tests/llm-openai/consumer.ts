/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Provider } from '@elmino/llm'
import { ResponsesProvider } from '@elmino/llm-openai'
import { ChatCompletionsProvider } from '@elmino/llm-openai/chat-completions'
import { ResponsesProvider as Responses } from '@elmino/llm-openai/responses'
import { verifyModelProtocol, verifyProvider } from '../llm/support'

const request = verifyModelProtocol()
const adapter: Provider = ResponsesProvider.create({ model: 'local', apiKeyRequired: false })
await verifyProvider(adapter, {
  id: 'resp-local',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
}, request)
if (Responses !== ResponsesProvider)
  throw new Error('子路径与根出口不一致')
ChatCompletionsProvider.create({ model: 'local', apiKeyRequired: false })
