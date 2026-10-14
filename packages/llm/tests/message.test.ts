import type { Message } from '@elmino/llm'
import { attachToolResults, createToolResultPart, extractReasoning, extractText, pendingToolCalls } from '@elmino/llm'
import { createToolCall, createToolCallStart } from '@elmino/llm/adapter'
import { describe, expect, test } from 'vitest'

describe('公共消息与工具回放', () => {
  test('文本与推理按公共 Part 类型提取', () => {
    const message: Message = {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先检查' },
        { type: 'text', text: '完成' },
        { type: 'image', mime: 'image/png', data: 'aGVsbG8=' },
      ],
    }

    expect(extractText(message)).toBe('完成')
    expect(extractReasoning(message)).toBe('先检查')
  })

  test.each(['', '{"city":', '[]', 'null', '"杭州"'])(
    '残缺或非对象参数保留草稿和无效标记：%s',
    (argsText) => {
      expect(createToolCall('native-call', 'weather', argsText)).toMatchObject({
        id: 'native-call',
        args: {},
        argsText,
        invalidArgs: true,
      })
      expect(createToolCallStart('native-call', 'weather')).not.toHaveProperty('invalidArgs')
    },
  )

  test('多工具结果乱序到达与恢复重试保持原调用顺序和幂等', () => {
    const messages: Message[] = [{
      role: 'assistant',
      parts: [
        createToolCall('call-first', 'first', '{}'),
        createToolCall('call-second', 'second', '{}'),
      ],
    }]

    attachToolResults(messages, [createToolResultPart('call-second', 'second')])
    expect(pendingToolCalls(messages).map(call => call.id)).toEqual(['call-first'])
    attachToolResults(messages, [createToolResultPart('call-first', 'first')])
    attachToolResults(messages, [createToolResultPart('call-second', 'retried')])

    expect(pendingToolCalls(messages)).toEqual([])
    expect(messages).toHaveLength(2)
    expect(messages[1]?.parts).toEqual([
      createToolResultPart('call-first', 'first'),
      createToolResultPart('call-second', 'retried'),
    ])
  })

  test('不属于当前工具批次的结果拒绝写入，不破坏历史', () => {
    const messages: Message[] = [{
      role: 'assistant',
      parts: [createToolCall('native-call', 'weather', '{}')],
    }]
    const before = structuredClone(messages)

    expect(() => attachToolResults(messages, [createToolResultPart('unknown', 'bad')])).toThrow()
    expect(messages).toEqual(before)
  })
})
