/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Provider } from '@elmino/llm'
import { AnthropicMessagesProvider } from '@elmino/llm-anthropic'
import { verifyModelProtocol, verifyProvider } from '../llm/support'

const request = verifyModelProtocol()
const adapter: Provider = AnthropicMessagesProvider.create({ model: 'local', apiKeyRequired: false })
await verifyProvider(adapter, {
  id: 'msg-local',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
}, request)
