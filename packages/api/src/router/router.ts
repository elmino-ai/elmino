import type { ContractRouterClient } from '@orpc/contract'
import { agentContract } from '../agent/contract'
import { eventContract } from '../events/contract'
import { metaContract } from '../meta/contract'
import { threadContract } from '../thread/contract'
import { turnContract } from '../turn/contract'

/** 只包含通用执行与读取能力，不注册产品配置、插件或工作区管理路由 */
export const apiContract = {
  meta: metaContract,
  agent: agentContract,
  thread: threadContract,
  turn: turnContract,
  events: eventContract,
}

/** Server 与 SDK 共用同一份契约推导客户端 */
export type ApiClient = ContractRouterClient<typeof apiContract>
