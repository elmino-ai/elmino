import { createId } from '@elmino/shared'
import { expect, test } from 'vitest'
import { createRuntimeEventCursor, parseRuntimeEventCursor } from '../src/index'

/** -------------------- 测试 -------------------- */
test('事件流 ID 和安全整数位置可以往返，游标与领域事件 ID 不混用', () => {
  const streamId = createId('stream')
  for (const sequence of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const cursor = { streamId, sequence }
    expect(parseRuntimeEventCursor(createRuntimeEventCursor(cursor))).toEqual(cursor)
  }
  expect(parseRuntimeEventCursor(createId('event'))).toBeUndefined()
})

test('拒绝损坏和非规范游标，重启与回放窗口校验留给持有队列的 Server', () => {
  const streamId = createId('stream')
  for (const sequence of ['-1', '+1', '01', '1.0', '1e3', ' 1', '1\n', '', '9007199254740992'])
    expect(parseRuntimeEventCursor(`${streamId}:${sequence}`)).toBeUndefined()
  for (const value of [undefined, null, 1, 'stream_old:1', `${streamId}:1:2`])
    expect(parseRuntimeEventCursor(value)).toBeUndefined()
  for (const sequence of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    expect(() => createRuntimeEventCursor({ streamId, sequence })).toThrow(TypeError)
})
