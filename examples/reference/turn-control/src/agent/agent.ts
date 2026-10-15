/**
 * 行为定义：把提示词、工具与 Runtime 组合成一个 Agent
 *
 * id 是宿主使用的稳定语义键；在 Server 注册表中，注册键必须与该 id 一致
 * 这里只描述怎么做事，不在定义阶段打开数据库、调用模型或创建执行资源
 * 单次调用的 input、model、store 和 workspace 由 app/run.ts 或 Engine 请求提供
 */
import { defineAgent } from '@elmino/agent'
import { defineTools } from '@elmino/tool'
import { z } from 'zod'
import { runtime } from '../runtime/runtime'

/** 等待工具只用于保留演示操作窗口，运行控制实际调用 Engine API */
export function createAssistant(waitForControl: (signal?: AbortSignal) => Promise<void>) {
  return defineAgent({
    id: 'assistant',
    systemPrompt: '先调用一次 wait_for_input 等待用户补充，工具返回后按最新用户要求回答，不重复等待',
    runtime,
    tools: defineTools({
      wait_for_input: {
        description: '暂停当前工具，等待宿主提交补充需求或中断本次执行',
        schema: z.object({}),
        scope: 'inspect',
        async execute(_args, { signal }) {
          await waitForControl(signal)
          return '宿主已提交补充，请按最新需求回复'
        },
      },
    }),
  })
}
