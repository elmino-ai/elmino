import { defineAgent } from '@elmino/agent'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/write-note'

/** 只定义 Agent 的行为与运行环境，任务和资源生命周期由应用入口管理 */
export const writer = defineAgent({
  id: 'writer',
  systemPrompt: '调用 write_note 将用户要求的内容写入文件，工具返回后说明结果，不重复写入',
  runtime,
  tools,
})
