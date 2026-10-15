/**
 * 行为定义：把提示词、工具与 Runtime 组合成一个 Agent
 *
 * id 是宿主使用的稳定语义键；在 Server 注册表中，注册键必须与该 id 一致
 * 这里只描述怎么做事，不在定义阶段打开数据库、调用模型或创建执行资源
 * 单次调用的 input、model、store 和 workspace 由 app/run.ts 或 Engine 请求提供
 */
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
