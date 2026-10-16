import {
  EVENT_ID_PATTERN,
  EventIdSchema,
  INTERRUPT_ID_PATTERN,
  InterruptIdSchema,
  MESSAGE_ID_PATTERN,
  MessageIdSchema,
  PART_ID_PATTERN,
  PartIdSchema,
  STREAM_ID_PATTERN,
  StreamIdSchema,
  THREAD_ID_PATTERN,
  THREAD_PART_ID_PATTERN,
  ThreadIdSchema,
  ThreadPartIdSchema,
  TOOL_CALL_ID_PATTERN,
  ToolCallIdSchema,
  TURN_ID_PATTERN,
  TurnIdSchema,
} from '@elmino/protocol'
import { expect, test } from 'vitest'
import { z } from 'zod'

/** 公开 ID 契约同时供运行校验、HTTP 参数与生成文档消费 */
const identifiers = [
  { name: 'event', schema: EventIdSchema, pattern: EVENT_ID_PATTERN },
  { name: 'thread', schema: ThreadIdSchema, pattern: THREAD_ID_PATTERN },
  { name: 'turn', schema: TurnIdSchema, pattern: TURN_ID_PATTERN },
  { name: 'message', schema: MessageIdSchema, pattern: MESSAGE_ID_PATTERN },
  { name: 'part', schema: PartIdSchema, pattern: PART_ID_PATTERN },
  { name: 'tool', schema: ToolCallIdSchema, pattern: TOOL_CALL_ID_PATTERN },
  { name: 'interrupt', schema: InterruptIdSchema, pattern: INTERRUPT_ID_PATTERN },
  { name: 'stream', schema: StreamIdSchema, pattern: STREAM_ID_PATTERN },
  { name: 'thread part', schema: ThreadPartIdSchema, pattern: THREAD_PART_ID_PATTERN },
]

test.each(identifiers)('$name 文档包含原有格式、字段说明与可直接通过校验的示例', ({ schema, pattern }) => {
  const document = z.toJSONSchema(schema)
  expect(document).toMatchObject({ type: 'string', pattern: pattern.source, description: expect.any(String) })
  expect(document.description).not.toBe('')
  expect(document.examples?.length).toBeGreaterThan(0)
  for (const example of document.examples ?? [])
    expect(schema.parse(example)).toBe(example)
})

test('持久化片段与线程片段保留不同范围，不收紧消息派生与插件语义键', () => {
  const messageId = 'msg_123e4567-e89b-42d3-a456-426614174000'
  for (const value of [`${messageId}:reasoning`, `${messageId}:tool:call_native`, 'plugin:plan:call_native']) {
    expect(ThreadPartIdSchema.parse(value)).toBe(value)
    expect(PartIdSchema.safeParse(value).success).toBe(false)
  }
  for (const value of [`${messageId}:text`, `${messageId}:tool:`, 'plugin:', 'plugin:has space'])
    expect(ThreadPartIdSchema.safeParse(value).success).toBe(false)
})

test('内核 ID 仍拒绝供应商原生调用标识、错误 UUID 版本与其他领域前缀', () => {
  expect(ToolCallIdSchema.safeParse('call_native').success).toBe(false)
  for (const value of [
    'turn_123e4567-e89b-12d3-a456-426614174000',
    'turn_123e4567-e89b-42d3-7456-426614174000',
    'thread_123e4567-e89b-42d3-a456-426614174000',
  ]) {
    expect(TurnIdSchema.safeParse(value).success).toBe(false)
  }
})
