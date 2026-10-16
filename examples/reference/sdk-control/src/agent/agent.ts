import { defineAgent } from '@elmino/agent'
import { defineTools } from '@elmino/tool'
import { z } from 'zod'
import { runtime } from '../runtime/runtime'
import { createGate } from './gate'

/**
 * 等待门控归示例宿主，SDK 只通过远程 API 控制执行
 */
export function createAssistant() {
  // 两个独立门控分别固定中断演示与重新观察演示的操作时机
  const gates = { interrupt: createGate(), attach: createGate() }
  // 只装配等待和回显工具，让读者集中观察 SDK 控制行为
  const agent = defineAgent({
    id: 'assistant',
    systemPrompt: '按照演示要求调用工具，再说明结果',
    runtime,
    tools: defineTools({
      wait_for_host: {
        description: '等待宿主操作，用于稳定展示运行中的控制',
        schema: z.object({ label: z.enum(['interrupt', 'attach']) }),
        scope: 'inspect',
        /**
         * 等待相应宿主操作，远端中断通过 signal 结束工具
         */
        async execute({ label }, { signal }) {
          await gates[label].wait(signal)
          return '等待结束'
        },
      },
      echo: {
        description: '回显内容，用于展示执行前的人工审批',
        schema: z.object({ text: z.string() }),
        approval: 'auto',
        /** 审批通过后回显原输入，便于核对工具是否真正执行 */
        execute: ({ text }) => text,
      },
    }),
  })
  return { agent, gates }
}
