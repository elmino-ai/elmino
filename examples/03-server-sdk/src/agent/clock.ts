import { defineAgent } from '@elmino/agent'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/current-time'

/** 客户端通过 clock 调用的服务端 Agent */
export const clock = defineAgent({
  id: 'clock',
  systemPrompt: '调用 current_time 读取服务端当前时间，再用中文简短说明结果，不重复调用工具',
  runtime,
  tools,
})
