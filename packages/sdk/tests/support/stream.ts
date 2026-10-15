import type { RuntimeEvent } from '@elmino/thread/events'

/** 每条测试流使用独立于领域事实 ID 的固定身份 */
export const streamId = 'stream_11111111-1111-4111-8111-111111111111'
/** 订阅的 Agent 和工作区由宿主显式提供 */
export const scope = { agentId: 'assistant', workspaceId: 'workspace' }

/** 创建可通过真实跨端 Schema 的最小事实事件 */
export function createEvent(sequence: number): RuntimeEvent {
  return {
    id: `event_11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`,
    type: 'turn.started',
    threadId: 'thread_22222222-2222-4222-8222-222222222222',
    turnId: 'turn_33333333-3333-4333-8333-333333333333',
    createdAt: '2026-10-15T00:00:00.000Z',
    payload: {},
  }
}

/** 使用 oRPC 公开 Event Iterator 的实际 SSE 数据格式 */
export function frame(message: unknown, id?: string): string {
  return [
    ...(id === undefined ? [] : [`id: ${id}`]),
    'event: message',
    `data: ${JSON.stringify({ json: message })}`,
    '',
    '',
  ].join('\n')
}

/** 创建传输完成后关闭的连接 */
export function closedStream(frames: string[]): Response {
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })
}

/** 持有真实 Web reader，便于断言 unsubscribe 主动取消正文 */
export function openStream(frames: string[] = []) {
  const cancelled = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of frames)
        controller.enqueue(new TextEncoder().encode(value))
    },
    cancel() {
      cancelled.resolve()
    },
  })
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancelled: cancelled.promise,
  }
}

/** 仅等待内存中的 Promise 与 Web Streams 推进，不引入真实重连等待 */
export async function flushUntil(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000; index++) {
    if (condition())
      return
    await Promise.resolve()
  }
  throw new Error('异步事件流未到达预期状态')
}
