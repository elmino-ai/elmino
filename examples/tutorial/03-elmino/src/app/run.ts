/**
 * Tutorial 03 · 本地调用 Elmino：定义一次 → 执行两轮 → 查询历史 → 关闭
 *
 * 与前面的 runAgent 单次调用相比，模型、Agent 和工作区都注册在应用实例上
 * 本例没有监听端口或远程客户端；run 等待当前 Turn 完成后才返回
 */
import { createExampleElmino } from './elmino'

/** 使用同一个应用与线程完成两轮任务；创建方负责最终关闭实例 */
export async function runExample(elmino = createExampleElmino()) {
  try {
    // 第 2 步：读取注册表无需打开模型或存储；通过 agentId 选择要运行的定义
    console.log('已注册 Agent：', elmino.listAgents().map(agent => agent.id).join(', '))
    const first = await elmino.run({
      agentId: 'clock',
      input: '请调用 current_time 读取当前 UTC 时间，并用中文简短说明',
      signal: AbortSignal.timeout(60_000),
    })
    if (first.status !== 'completed')
      throw new Error(first.errorMessage ?? `第一轮任务结束：${first.status}`)

    // 第 3 步：第一轮自动生成 threadId / turnId；传回 threadId 即可延续上下文
    const second = await elmino.run({
      agentId: 'clock',
      threadId: first.threadId,
      input: '沿用上一轮读取的时间，用一句话总结，不要再次调用工具',
      signal: AbortSignal.timeout(60_000),
    })
    if (second.status !== 'completed')
      throw new Error(second.errorMessage ?? `第二轮任务结束：${second.status}`)

    // 第 4 步：查询同一工作区中的持久化历史；run 返回完成状态，无需轮询或等待事件
    const state = await elmino.getThread({
      agentId: 'clock',
      workspaceId: second.workspaceId,
      threadId: second.threadId,
    })
    for (const message of state.messages) {
      if (message.role !== 'assistant')
        continue
      for (const part of message.parts) {
        // 只展示模型实际提供的可见思考与正文；工具结果也来自持久化记录
        if ((part.type === 'reasoning' || part.type === 'text') && part.text.trim())
          console.log(`${part.type === 'reasoning' ? '思考' : '回复'}：\n${part.text}`)
        if (part.type === 'tool')
          console.log(`工具 ${part.toolName}：${part.output ?? ''}`)
      }
    }
    console.log('线程 ID：', state.threadId)
    console.log('已完成轮数：', state.turns.filter(turn => turn.status === 'completed').length)
    console.log('最终状态：', second.status)
    return state
  }
  finally {
    // 第 5 步：复用期间保持实例存活，结束后结算执行并释放 sqliteStore 的存储租约
    await elmino.close()
  }
}
