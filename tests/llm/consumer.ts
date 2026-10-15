import type { Provider } from '@elmino/llm'
import { verifyModelProtocol } from './support'

verifyModelProtocol()
const adapter: Provider | undefined = undefined
if (adapter)
  throw new Error('协议包不应包含适配器')
