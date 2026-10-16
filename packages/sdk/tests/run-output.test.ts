import type { ThreadState } from '@elmino/thread'
import { createId } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread/events'
import { expect, test, vi } from 'vitest'
import { createRunOutput } from '../src/run/output'

/** 同一助手片段跨连接、完整消息和增量事件共用身份 */
function fixture() {
  const threadId = createId('thread')
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const timestamp = '2026-10-16T00:00:00.000Z'
  const message = (text: string): ThreadState['messages'][number] => ({
    id: messageId,
    threadId,
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
    parts: [{ id: partId, threadId, turnId, messageId, seq: 1, type: 'text', text, status: 'running', createdAt: timestamp, updatedAt: timestamp }],
  })
  return {
    turnId,
    message,
    update: (text: string) => createRuntimeEvent({ type: 'message.updated', threadId, turnId, messageId, payload: { message: message(text) } }),
    delta: (text: string) => createRuntimeEvent({ type: 'message.part.delta', threadId, turnId, messageId, partId, payload: { delta: { text } } }),
  }
}

test('reset 查询已读到缓冲增量之后的正文时，补齐尾部并避免再次追加无偏移 delta', async () => {
  const data = fixture()
  const text = vi.fn()
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  await output.event(data.update(''))
  const initial = data.delta('A')
  await output.event(initial)
  await output.event(initial)
  expect(text.mock.calls.flat().join('')).toBe('A')

  output.reset()
  // reset 的查询晚于 B/C 的生成，快照已包含它们；缓冲事件稍后才送达
  await output.snapshot({ messages: [data.message('ABC')] }, data.turnId)
  await output.event(data.delta('B'))
  await output.event(data.delta('C'))
  await output.event(data.delta('D'))
  // 缺少原连接的定位锚点时，不猜测 delta 在快照中的位置；完整消息负责补齐
  expect(text.mock.calls.flat().join('')).toBe('ABC')
  await output.event(data.update('ABCDE'))
  await output.snapshot({ messages: [data.message('ABCDE')] }, data.turnId)
  expect(text.mock.calls.flat().join('')).toBe('ABCDE')
  expect(text.mock.calls).toEqual([['A'], ['BC'], ['DE']])
})

test('快照不重新展示前一轮内容，输出回调的异常保留原始拒绝原因', async () => {
  const data = fixture()
  const error = new Error('展示失败')
  const text = vi.fn(() => {
    throw error
  })
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  await output.snapshot({ messages: [data.message('旧内容')] }, createId('turn'))
  expect(text).not.toHaveBeenCalled()
  await expect(output.event(data.update('新内容'))).rejects.toBe(error)
})

test('先到达的空白不会在后续非空内容中丢失，增量仍保持原始格式', async () => {
  const data = fixture()
  const text = vi.fn()
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  await output.event(data.update(''))
  await output.event(data.delta('\n  '))
  await output.event(data.delta('代码'))
  await output.event(data.delta(' '))
  expect(text.mock.calls.flat().join('')).toBe('\n  代码 ')
})
