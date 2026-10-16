/**
 * 一个只读工具，让本例专注于应用装配和线程复用
 *
 * 模型只负责提出工具调用，execute 才在运行 Elmino 的本机读取时间
 * 工具结果会进入线程历史，第二轮可直接引用，不需要重新读取
 */
import { defineTools } from '@elmino/tool'
import { z } from 'zod'

/** inspect 声明只读用途，本例无需申请写入权限 */
export const tools = defineTools({
  current_time: {
    description: '读取当前的 UTC 时间',
    schema: z.object({}),
    scope: 'inspect',
    execute: () => new Date().toISOString(),
  },
})
