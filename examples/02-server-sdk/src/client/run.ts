import type { ThreadPart } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread/events'
import { readRuntimeEventMessagePayload } from '@elmino/protocol'
import { Client } from '@elmino/sdk'
import { createId, isOneOf } from '@elmino/shared'
import { readRuntimeEventPartPayload, TERMINAL_TURN_EVENT_TYPES } from '@elmino/thread/events'

/** 通过真实 HTTP 和 SSE 调用远程 Agent，完成后查询持久化结果 */
export async function runRemoteTask(baseUrl: string, key: string) {
  const client = Client.create({ baseUrl, apiKey: key })
  const target = { agentId: 'clock', workspaceId: 'example', threadId: createId('thread') }
  const turnId = createId('turn')
  const connected = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  completed.promise.catch(() => undefined)
  const deadline = new AbortController()
  const timer = setTimeout(() => {
    const error = new Error('远程示例等待超过 60 秒')
    deadline.abort(error)
    completed.reject(error)
  }, 60_000)
  const printed = new Set<string>()

  /** 完整片段在事件与快照恢复路径共用去重输出 */
  const printParts = (parts: ThreadPart[]) => {
    for (const part of parts) {
      if (part.status !== 'completed' || printed.has(part.id))
        continue
      printed.add(part.id)
      if (part.type === 'reasoning' || part.type === 'text')
        console.log(`${part.type === 'reasoning' ? '思考' : '回复'}：\n${part.text}`)
      if (part.type === 'tool')
        console.log(`工具 ${part.toolName}：${part.output ?? ''}`)
    }
  }

  /** 终态和持久化查询仍以 Server 为准 */
  const onEvent = (event: RuntimeEvent) => {
    if (event.threadId !== target.threadId)
      return
    const updated = readRuntimeEventPartPayload(event)
    printParts(readRuntimeEventMessagePayload(event)?.parts ?? (updated ? [updated] : []))
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
    onReset: async () => {
      try {
        const snapshot = await client.rpc.thread.get(target, { signal: deadline.signal })
        printParts(snapshot.messages.flatMap(message => message.parts))
        const turn = snapshot.turns.find(item => item.id === turnId)
        if (turn && ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) {
          if (turn.status === 'completed')
            completed.resolve()
          else
            completed.reject(new Error(`远程任务结束：${turn.status}`))
        }
      }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'NOT_FOUND'))
          throw error
      }
      connected.resolve()
    },
    onError: error => console.error('连接中断，SDK 正在自动重连', error),
  })
  try {
    await Promise.race([connected.promise, completed.promise])
    await client.rpc.turn.create({
      ...target,
      turnId,
      approvalMode: 'fullAccess',
      input: [{ type: 'text', text: '请调用工具读取 Server 当前时间，并说明远程调用已完成' }],
    }, { signal: deadline.signal })
    await completed.promise
    const state = await client.rpc.thread.get(target, { signal: deadline.signal })
    console.log('持久化 Turn 状态：', state.turns.find(turn => turn.id === turnId)?.status)
    return state
  }
  finally {
    stop()
    clearTimeout(timer)
    deadline.abort()
  }
}
