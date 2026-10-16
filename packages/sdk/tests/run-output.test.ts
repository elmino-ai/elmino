import type { ThreadState } from '@elmino/thread'
import { createId } from '@elmino/shared'
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
  return { turnId, message }
}

test('多次读取和重连补齐共用输出位置，不重复打印已展示正文', async () => {
  const data = fixture()
  const text = vi.fn()
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  await output.snapshot({ messages: [data.message('A')] }, data.turnId)
  await output.snapshot({ messages: [data.message('A')] }, data.turnId)
  await output.snapshot({ messages: [data.message('ABC')] }, data.turnId)
  await output.snapshot({ messages: [data.message('ABCDE')] }, data.turnId)
  expect(text.mock.calls).toEqual([['A'], ['BC'], ['DE']])
})

test('恢复基线跳过旧内容，只输出原Turn中恢复后的新增尾部', async () => {
  const data = fixture()
  const text = vi.fn()
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  output.seed({ messages: [data.message('审批前')] }, data.turnId)
  await output.snapshot({ messages: [data.message('审批前继续执行')] }, data.turnId)
  expect(text.mock.calls).toEqual([['继续执行']])
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
  await expect(output.snapshot({ messages: [data.message('新内容')] }, data.turnId)).rejects.toBe(error)
})

test('先到达的空白不会在后续非空内容中丢失，增量仍保持原始格式', async () => {
  const data = fixture()
  const text = vi.fn()
  const output = createRunOutput({ onText: text }, new AbortController().signal)
  await output.snapshot({ messages: [data.message('\n  ')] }, data.turnId)
  await output.snapshot({ messages: [data.message('\n  代码')] }, data.turnId)
  await output.snapshot({ messages: [data.message('\n  代码 ')] }, data.turnId)
  expect(text.mock.calls.flat().join('')).toBe('\n  代码 ')
})
