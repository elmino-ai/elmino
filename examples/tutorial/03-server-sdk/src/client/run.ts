/**
 * SDK 客户端阅读路线：连接 → 订阅 → 提交任务 → 等待终态 → 查询快照 → 退出
 *
 * 先在另一个终端启动 pnpm example:server-sdk，再执行 pnpm example:server-sdk:client
 * 客户端通过 HTTP 调用 Server，只有 Server 需要连接模型；客户端不创建 AgentEngine
 * 订阅事件用来展示进度，thread.get 用来确认最后保存的事实
 */
import type { ThreadPart } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread/events'
import { readRuntimeEventMessagePayload } from '@elmino/protocol'
import { Client } from '@elmino/sdk'
import { createId, isOneOf } from '@elmino/shared'
import { readRuntimeEventPartPayload, TERMINAL_TURN_EVENT_TYPES } from '@elmino/thread/events'

/** 通过真实 HTTP 和 SSE 调用远程 Agent，完成后查询持久化结果 */
export async function runRemoteTask(baseUrl: string, key: string) {
  // 第 1 步：baseUrl 指向 Server；这里的 key 是 SERVER_KEY，不是模型供应商密钥
  const client = Client.create({ baseUrl, apiKey: key })
  // Agent 与工作区键要和服务端定义一致；每次演示生成新的线程与 Turn 身份
  const target = { agentId: 'clock', workspaceId: 'example', threadId: createId('thread') }
  const turnId = createId('turn')
  // 连接就绪与任务完成是两个时点，不能在订阅尚未建立时就开始一项可能很快完成的任务
  const connected = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  // 订阅回调可能先于后续 await 报错，先附加拒绝观察器；真正的失败仍由下方 await 报告
  completed.promise.catch(() => undefined)
  // 这个期限限制客户端等待与请求，不代表向 Server 的执行器发送停止命令
  const deadline = new AbortController()
  const timer = setTimeout(() => {
    const error = new Error('远程示例等待超过 60 秒')
    deadline.abort(error)
    completed.reject(error)
  }, 60_000)
  // 断线回放和快照查询都可能再次带来相同片段，按身份去重才能避免重复打印
  const printed = new Set<string>()
  // 只展示助手回复，不能把用户提交的任务当作助手输出再打印一遍
  const assistantMessages = new Set<string>()

  /** 完整片段在事件与快照恢复路径共用去重输出 */
  const printParts = (parts: ThreadPart[]) => {
    for (const part of parts) {
      if (part.status !== 'completed' || printed.has(part.id))
        continue
      if ((part.type === 'reasoning' || part.type === 'text') && !part.text.trim())
        continue
      printed.add(part.id)
      if (part.type === 'reasoning' || part.type === 'text')
        console.log(`${part.type === 'reasoning' ? '思考' : '回复'}：\n${part.text}`)
      if (part.type === 'tool')
        console.log(`工具 ${part.toolName}：${part.output ?? ''}`)
    }
  }

  /** 终态和持久化查询仍以 Server 为准 */
  // 第 2 步：工作区流可能包含多个任务，只处理当前 threadId 和目标 turnId 的终态
  const onEvent = (event: RuntimeEvent) => {
    if (event.threadId !== target.threadId)
      return
    const updated = readRuntimeEventPartPayload(event)
    const message = readRuntimeEventMessagePayload(event)
    if (message?.role === 'assistant') {
      assistantMessages.add(message.id)
      printParts(message.parts)
    }
    else if (updated && assistantMessages.has(updated.messageId)) {
      printParts([updated])
    }
    if (event.turnId !== turnId || !isOneOf(event.type, TERMINAL_TURN_EVENT_TYPES))
      return
    if (event.type === 'turn.completed')
      completed.resolve()
    else
      completed.reject(new Error(`远程任务结束：${event.type}`))
  }

  // 线程尚未创建，先观察整个工作区，避免遗漏第一批事件
  const stop = client.subscribe({ agentId: target.agentId, workspaceId: target.workspaceId }, {
    onEvent,
    // 首次连接或无法继续回放时会 reset；重新读取快照，补回断线期间已经完成的内容
    onReset: async () => {
      try {
        const snapshot = await client.rpc.thread.get(target, { signal: deadline.signal })
        for (const message of snapshot.messages) {
          if (message.role !== 'assistant')
            continue
          assistantMessages.add(message.id)
          printParts(message.parts)
        }
        const turn = snapshot.turns.find(item => item.id === turnId)
        if (turn && ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) {
          if (turn.status === 'completed')
            completed.resolve()
          else
            completed.reject(new Error(`远程任务结束：${turn.status}`))
        }
      }
      catch (error) {
        // 首次订阅时线程尚未创建，NOT_FOUND 是预期情况；鉴权或其他错误不能吞掉
        if (!(error instanceof Error && 'code' in error && error.code === 'NOT_FOUND'))
          throw error
      }
      connected.resolve()
    },
    onError: error => console.error('连接中断，SDK 正在自动重连', error),
  })
  try {
    await Promise.race([connected.promise, completed.promise])
    // 第 3 步：Server 在接纳并持久化启动事实后返回，并不会等模型完成才响应
    await client.rpc.turn.create({
      ...target,
      turnId,
      approvalMode: 'fullAccess',
      input: [{ type: 'text', text: '请调用工具读取 Server 当前时间，并说明远程调用已完成' }],
    }, { signal: deadline.signal })
    // 第 4 步：任务终态从事件或 reset 后的快照得知，不以 turn.create 的 HTTP 返回为准
    await completed.promise
    // 第 5 步：最后再读一次权威快照，确认持久化结果，然后把客户端结果交给调用方
    const state = await client.rpc.thread.get(target, { signal: deadline.signal })
    console.log('持久化 Turn 状态：', state.turns.find(turn => turn.id === turnId)?.status)
    return state
  }
  finally {
    // 第 6 步：只结束本客户端订阅和期限计时；停止远程任务应显式调用 turn.interrupt
    stop()
    clearTimeout(timer)
    deadline.abort()
  }
}
