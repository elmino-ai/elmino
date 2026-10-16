/**
 * 服务端工具：用一个只读操作证明真正的执行发生在远端
 *
 * 模型提出 current_time 调用后，Server 中的处理器读取 Server 所在机器的当前时间
 * 返回值进入模型上下文，再由模型回复给 SDK；这里没有读取客户端电脑的时钟
 */
import { defineTools } from '@elmino/tool'
import { z } from 'zod'

/** 第三个示例只演示远程调用一个只读工具 */
export const tools = defineTools({
  current_time: {
    description: '读取 Server 当前的 UTC 时间',
    // 没有输入参数，默认不进入普通人工审批；本例只演示远端只读能力
    schema: z.object({}),
    scope: 'inspect',
    execute: () => new Date().toISOString(),
  },
})
