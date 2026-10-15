import { defineAgent } from '@elmino/agent'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/write-note'

/** 只定义 Agent 的行为与运行环境，任务和资源生命周期由应用入口管理 */
export const writer = defineAgent({
  id: 'writer',
  systemPrompt: '先按用户要求记住内容；只有用户明确要求写文件时才调用 write_note，内容沿用同一线程的对话；工具返回后说明结果，不重复写入',
  runtime,
  tools,
})
