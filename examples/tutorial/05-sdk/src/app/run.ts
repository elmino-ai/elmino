/**
 * Tutorial 05 · 绑定会话后远程调用 Agent
 *
 * 先启动 pnpm example:server，再运行 pnpm example:sdk
 * thread 固定 Agent、工作区和会话；run 自动订阅、提交一次任务并等待结果
 * 回调收到新增内容；本例直接打印，界面中通常追加到对应的正文或思考区域
 */
import type { Client } from '@elmino/sdk'
import { createExampleClient } from '../client/client'

/**
 * 客户端只关心调用哪个 Agent、发送什么内容，以及怎样展示结果
 */
export async function runRemoteTask(client: Client = createExampleClient()) {
  // 绑定一次身份即可；后面再次 thread.run 会自动沿用这段会话
  const thread = client.thread({ agentId: 'clock', workspaceId: 'example' })
  // 一行提交并等待本轮结果；回调只收到本轮新增的文本、思考和工具终态
  const result = await thread.run('请调用工具读取 Server 当前时间，并说明远程调用已完成', {
    signal: AbortSignal.timeout(60_000),
    /** 展示新增助手正文，界面通常把它追加到当前消息 */
    onText: text => console.log(`回复：\n${text}`),
    /** 仅打印模型实际返回的可见思考，未提供时不会伪造内容 */
    onReasoning: text => console.log(`思考：\n${text}`),
    /** 工具结束后展示结果；失败或跳过也会携带对应状态 */
    onToolResult: part => console.log(`工具 ${part.toolName}：${part.output ?? ''}`),
  })
  // run 已等待本轮结束；审批中断、失败和远端取消也会通过 status 返回
  if (result.status !== 'completed')
    throw new Error(`远程任务结束：${result.status}`)
  console.log('持久化 Turn 状态：', result.status)
  // 完整消息与工具记录已包含在结果中，无需再次手工查询
  return result.thread
}
