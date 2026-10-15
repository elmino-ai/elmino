import { defineTools } from '@elmino/tool'
import { z } from 'zod'

/** 第二个示例只演示远程调用一个只读工具 */
export const tools = defineTools({
  current_time: {
    description: '读取 Server 当前的 UTC 时间',
    schema: z.object({}),
    scope: 'inspect',
    execute: () => new Date().toISOString(),
  },
})
