import { JsonValueSchema, THREAD_PART_ID_PATTERN, ThreadInterruptSchema, ThreadPartWireSchema } from '@elmino/protocol'
import { createId } from '@elmino/shared'
import { expect, test } from 'vitest'
import { z } from 'zod'

const jsonTypes = ['string', 'number', 'boolean', 'null', 'array', 'object']

test('JSON 文档覆盖任意深度的数据，不用无法在嵌套位置解析的引用', () => {
  const value = { nested: [null, { array: [1, 'text', true] }] }
  expect(JsonValueSchema.parse(value)).toBe(value)
  for (const invalid of [{ missing: undefined }, { invalid: Number.NaN }, new Date(), () => null])
    expect(JsonValueSchema.safeParse(invalid).success).toBe(false)
  expect(z.globalRegistry.get(JsonValueSchema)?.jsonSchema).toMatchObject({ type: jsonTypes })
  expect(JSON.stringify(z.globalRegistry.get(JsonValueSchema)?.jsonSchema)).not.toContain('$ref')
})

test('中断文档保留具体字段、必填约束和交互恢复分支，运行校验仍由领域判定', () => {
  const schema = z.globalRegistry.get(ThreadInterruptSchema)?.jsonSchema
  expect(schema).toMatchObject({
    type: 'object',
    properties: {
      id: {
        type: 'string',
        pattern: expect.stringContaining('interrupt_'),
        description: expect.any(String),
        examples: expect.arrayContaining(['interrupt_123e4567-e89b-42d3-a456-426614174000']),
      },
      payload: { type: jsonTypes },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'kind', 'status', 'turnId', 'reason', 'createdAt', 'resumableWith'],
    allOf: [{ then: { required: ['interaction', 'payload'] } }],
  })
  const interrupt = {
    id: createId('interrupt'),
    kind: 'interaction',
    interaction: 'approval',
    status: 'pending',
    turnId: createId('turn'),
    reason: 'approval',
    createdAt: '2026-10-15T08:00:00Z',
    resumableWith: ['interaction'],
    payload: { question: 'continue' },
    ownerId: undefined,
  }
  expect(ThreadInterruptSchema.parse(interrupt)).toBe(interrupt)
  expect(ThreadInterruptSchema.safeParse({ ...interrupt, payload: { bad: undefined } }).success).toBe(false)
  expect(ThreadInterruptSchema.safeParse({ ...interrupt, createdAt: 'invalid' }).success).toBe(false)
})

test('片段文档从领域联合生成完整九类，工具参数和扩展值保留 JSON 语义', () => {
  const schema = z.globalRegistry.get(ThreadPartWireSchema)?.jsonSchema as z.core.JSONSchema.BaseSchema
  expect(schema.oneOf).toHaveLength(9)
  const parts = schema.oneOf?.filter(part => typeof part !== 'boolean') ?? []
  expect(parts.map(part => part.properties?.type)).toContainEqual({ type: 'string', const: 'tool' })
  for (const part of parts) {
    expect(part.properties?.id).toMatchObject({
      pattern: THREAD_PART_ID_PATTERN.source,
      description: expect.any(String),
      examples: expect.arrayContaining(['plugin:custom-note']),
    })
    expect(part.properties?.createdAt).toMatchObject({ type: 'string', format: 'date-time' })
  }
  const tool = parts.find(part => typeof part.properties?.type === 'object' && part.properties.type.const === 'tool')
  expect(tool?.properties?.args).toMatchObject({ type: jsonTypes })
  // 供应商原生调用标识继续由供应商定义，不附加内核 tool_<UUID> 格式
  expect(tool?.properties?.providerCallId).toMatchObject({ type: 'string' })
  expect(tool?.properties?.providerCallId).not.toHaveProperty('pattern')
  expect(tool?.required).not.toContain('args')
  const text = JSON.stringify(schema)
  expect(text).not.toContain('$ref')
  expect(text).not.toContain('"not":{}')
  expect(text).not.toContain(':{}')
})
