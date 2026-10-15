/**
 * 行为定义：把提示词、工具与 Runtime 组合成一个 Agent
 *
 * id 是宿主使用的稳定语义键；在 Server 注册表中，注册键必须与该 id 一致
 * 这里只描述怎么做事，不在定义阶段打开数据库、调用模型或创建执行资源
 * 单次调用的 input、model、store 和 workspace 由 app/run.ts 或 Engine 请求提供
 */
import { defineAgent } from '@elmino/agent'
import { createHooks } from '../hooks/hooks'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/write-note'

/** 宿主注入日志观察器，Hooks 只管理当前 Turn 的资源与工具策略 */
export function createWriter(log: (message: string) => void) {
  const hooks = createHooks(log)
  return defineAgent({
    id: 'writer',
    systemPrompt: '按用户要求调用 write_note 保存便签；工具返回后说明结果，不重复写入',
    tools,
    runtime,
    hooks,
  })
}
