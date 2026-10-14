import { describe, expect, test } from 'vitest'
import { readPartialToolArgs } from '../src/loop/step/tool-input.js'

/** -------------------- 测试 -------------------- */
describe('流式工具参数草稿', () => {
  test.each([
    {
      input: '{"title":"计划","plan":"# 第一段',
      expected: { title: '计划', plan: '# 第一段' },
    },
    {
      input: '{"meta":{"version":1},"plan":"嵌套字段之后',
      expected: { meta: { version: 1 }, plan: '嵌套字段之后' },
    },
    {
      input: '{"plan":"第一行\\n第二行',
      expected: { plan: '第一行\n第二行' },
    },
    {
      input: '{"plan":"中文\\u4e',
      expected: { plan: '中文' },
    },
    {
      input: '{"plan":"\\ud83d\\ude00',
      expected: { plan: '😀' },
    },
    {
      input: '{"enabled":true,"count":2,"empty":null}',
      expected: { enabled: true, count: 2, empty: null },
    },
  ])('从未闭合 JSON 读取当前可展示参数', ({ input, expected }) => {
    expect(readPartialToolArgs(input)).toEqual(expected)
  })

  test('不猜测非法转义和未完成字段', () => {
    expect(readPartialToolArgs('{"plan":"非法\\q')).toBeUndefined()
    expect(readPartialToolArgs('{"pla')).toBeUndefined()
    expect(readPartialToolArgs('{"plan":"\\ud83d')).toEqual({ plan: '' })
    expect(readPartialToolArgs('{"plan":[]]')).toBeUndefined()
  })
})
