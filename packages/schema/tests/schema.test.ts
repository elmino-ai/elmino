import { expect, test } from 'vitest'
import { z } from 'zod'
import {
  HttpOriginSchema,
  HttpOriginsSchema,
  HttpUrlSchema,
  ListenPortSchema,
  NonBlankStringSchema,
  PortSchema,
  TrimmedStringSchema,
} from '../src/index'

test('身份字符串保留原值，只有明确归一化的配置字段才 trim', () => {
  expect(NonBlankStringSchema.parse(' writer ')).toBe(' writer ')
  expect(TrimmedStringSchema.parse(' writer ')).toBe('writer')
  for (const schema of [NonBlankStringSchema, TrimmedStringSchema]) {
    expect(schema.safeParse('').success).toBe(false)
    expect(schema.safeParse('  ').success).toBe(false)
  }
})

test('监听与连接端口有不同边界，基础规则不隐式接受字符串', () => {
  expect(ListenPortSchema.parse(0)).toBe(0)
  expect(PortSchema.safeParse(0).success).toBe(false)
  for (const schema of [ListenPortSchema, PortSchema]) {
    expect(schema.parse(65_535)).toBe(65_535)
    for (const input of [-1, 65_536, 3.14, '3000'])
      expect(schema.safeParse(input).success).toBe(false)
  }
  expect(z.coerce.number().pipe(PortSchema).parse('3000')).toBe(3000)
})

test.each(['*', 'null', 'file:///tmp/data', 'https://user:pass@example.test', 'https://example.test/', 'https://example.test/path', 'https://example.test?key=value', 'https://example.test#fragment'])('精确来源拒绝 %s，非法 URL 不产生额外异常', (input) => {
  expect(HttpOriginSchema.safeParse(input).success).toBe(false)
})

test('HTTP 地址与来源列表保持各自语义，说明可直接进入 JSON Schema', () => {
  expect(HttpUrlSchema.parse('https://example.test/api')).toBe('https://example.test/api')
  expect(HttpUrlSchema.safeParse('ftp://example.test').success).toBe(false)
  expect(HttpOriginsSchema.parse(['http://localhost:5173', 'https://example.test'])).toHaveLength(2)
  expect(z.toJSONSchema(PortSchema)).toMatchObject({ type: 'integer', minimum: 1, maximum: 65_535, description: expect.any(String) })
  expect(z.toJSONSchema(HttpOriginSchema)).toMatchObject({ examples: ['http://localhost:5173'] })
})
