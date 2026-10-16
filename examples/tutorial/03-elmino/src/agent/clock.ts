/**
 * Agent 描述怎么做事，Elmino 决定它使用哪些模型与工作区
 *
 * id 必须与应用 agents 的注册键 clock 一致
 * 这里没有模型密钥、存储实例或 HTTP 配置，后续也能把这份定义交给 Server
 */
import { defineAgent } from '@elmino/agent'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/current-time'

/** 只在用户要求读取时间时调用工具，后续消息可以直接沿用线程历史 */
export const clock = defineAgent({
  id: 'clock',
  systemPrompt: '按用户要求调用 current_time 读取当前 UTC 时间，用中文简短回复。用户要求沿用历史时间时，不要重复调用工具',
  runtime,
  tools,
})
