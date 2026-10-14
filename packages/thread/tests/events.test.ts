import { createId } from '@elmino/shared'
import {
  applyRuntimeToolOutputDelta,
  createRuntimeEvent,
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
  readThreadInputText,
  readThreadInteraction,
  readThreadInterrupt,
  readThreadMentionReference,
  sortThreadInputContent,
} from '@elmino/thread'
import { expect, test } from 'vitest'

test('消息增量按字符偏移幂等追加并拒绝缺口和冲突', () => {
  expect(applyRuntimeToolOutputDelta('abc', { offset: 3, output: 'def' })).toBe('abcdef')
  expect(applyRuntimeToolOutputDelta('abcdef', { offset: 3, output: 'def' })).toBe('abcdef')
  expect(applyRuntimeToolOutputDelta('abc', { offset: 4, output: 'def' })).toBeUndefined()
  expect(applyRuntimeToolOutputDelta('abcdef', { offset: 3, output: 'xyz' })).toBeUndefined()
})

test('完整片段事件核对 Thread、Turn 和工具归属，增量不接纳负数或非整数偏移', () => {
  const threadId = createId('thread')
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const toolCallId = createId('tool')
  const timestamp = new Date().toISOString()
  const part = {
    type: 'tool',
    id: partId,
    threadId,
    turnId,
    messageId,
    toolCallId,
    toolName: 'lookup',
    seq: 1,
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    output: 'abc',
  }
  const event = createRuntimeEvent({ type: 'message.part.updated', threadId, turnId, messageId, partId, toolCallId, payload: { part } })

  expect(readRuntimeEventPartPayload(event)).toEqual(part)
  expect(readRuntimeEventPartPayload({ ...event, threadId: createId('thread') })).toBeUndefined()
  expect(readRuntimeEventPartPayload({ ...event, toolCallId: createId('tool') })).toBeUndefined()
  const delta = createRuntimeEvent({ type: 'message.part.delta', threadId, turnId, messageId, partId, toolCallId, payload: { delta: { offset: 3, output: 'def' } } })

  expect(readRuntimeEventPartDeltaPayload(delta)).toEqual({ delta: { offset: 3, output: 'def' } })
  expect(readRuntimeEventPartDeltaPayload({ ...delta, payload: { delta: { offset: -1, output: 'x' } } })).toBeUndefined()
  expect(readRuntimeEventPartDeltaPayload({ ...delta, payload: { delta: { offset: 0.5, output: 'x' } } })).toBeUndefined()
})

test('中断恢复和 Mention 保留可持久 JSON，输入排序保持文本与引用的相对顺序', () => {
  const turnId = createId('turn')
  const interrupt = {
    id: createId('interrupt'),
    kind: 'interaction',
    interaction: 'confirm',
    status: 'pending',
    turnId,
    reason: 'confirm',
    payload: { nested: ['json', 1] },
    createdAt: new Date().toISOString(),
    resumableWith: ['interaction'],
  }

  expect(readThreadInteraction(readThreadInterrupt(interrupt))).toEqual(interrupt)
  expect(readThreadInterrupt({ ...interrupt, payload: { fn: () => undefined } })).toBeUndefined()
  const mention = { type: 'mention' as const, pluginId: 'host', resourceId: 'file', trigger: '@', label: 'file' }
  const text = { type: 'text' as const, text: 'read ' }
  const document = { type: 'document' as const, name: 'custom', extension: 'custom-format', data: 'base64' }

  expect(readThreadMentionReference({ ...mention, data: { fn: () => undefined } })).toBeUndefined()
  const sorted = sortThreadInputContent([text, mention, document])

  expect(sorted).toEqual([document, text, mention])
  expect(readThreadInputText(sorted)).toBe('read file')
})
