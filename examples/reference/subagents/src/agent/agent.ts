/**
 * 行为定义：把提示词、工具与 Runtime 组合成一个 Agent
 *
 * id 是宿主使用的稳定语义键；在 Server 注册表中，注册键必须与该 id 一致
 * 这里只描述怎么做事，不在定义阶段打开数据库、调用模型或创建执行资源
 * 单次调用的 input、model、store 和 workspace 由 app/run.ts 或 Engine 请求提供
 */
import { defineAgent } from '@elmino/agent'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/delegate'

/** 子任务也使用当前 Agent 定义，由角色指令和任务说明约束各自职责 */
export const coordinator = defineAgent({
  id: 'coordinator',
  systemPrompt: '用户要求分工时调用 delegate_task，每个独立任务各调用一次，最后汇总结果；作为子任务时只回答当前问题，不再派生任务',
  tools,
  runtime,
})
