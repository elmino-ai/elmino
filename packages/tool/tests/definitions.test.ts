import type { Sandbox } from '@elmino/sandbox'
import type { ToolExecutionContext } from '@elmino/tool'
import {
  createHostServices,
  defineHostService,
  defineTool,
  defineTools,
  mergeTools,
  provideHostService,
  resolveToolScope,
} from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'

/** 参数校验测试不调用沙箱，使用独立取消信号和进度回调 */
const context: ToolExecutionContext = {
  sandbox: {} as Sandbox,
  signal: new AbortController().signal,
  onToolProgress: vi.fn(),
}

test('tool declaration and execution share input schema including defaults and validation', () => {
  const execute = vi.fn((args: { count: number }) => String(args.count))
  const tool = defineTool({
    name: 'count',
    description: 'Count values',
    schema: z.object({ count: z.number().default(2) }),
    execute,
  })

  expect(tool.declaration.name).toBe('count')
  expect(tool.declaration.schema).toMatchObject({ type: 'object', properties: { count: { default: 2 } } })
  expect(tool.execute({}, context)).toBe('2')
  expect(execute).toHaveBeenCalledWith({ count: 2 }, context)
  expect(() => tool.execute({ count: 'invalid' }, context)).toThrow('工具参数无效: count:')
  expect(execute).toHaveBeenCalledOnce()
})

test('tools retain approval, visibility and concurrency defaults and explicit settings', () => {
  const tools = defineTools({
    serial: { description: 'Serial', schema: z.object({}), execute: () => '' },
    parallel: { description: 'Parallel', schema: z.object({}), execute: () => '', parallel: true, hidden: true, approval: 'auto' },
  })

  expect(tools.handlers.serial).toMatchObject({ approval: 'never', parallel: false })
  expect(tools.handlers.parallel).toMatchObject({ approval: 'auto', parallel: true, hidden: true })
  expect(tools.declarations.map(tool => tool.name)).toEqual(['serial', 'parallel'])
})

test('scope and approval projections parse typed args and conservatively reject invalid input', () => {
  const scope = vi.fn(() => ({ scope: 'inspect' as const }))
  const review = vi.fn((args: { path: string }) => ({ kind: 'file' as const, action: 'read' as const, filePath: args.path }))
  const schema = z.object({ path: z.string() })
  const tool = defineTool({
    name: 'read',
    description: 'Read',
    schema,
    execute: () => '',
    scope,
    review,
  })

  expect(resolveToolScope(tool, { path: '/file' }, context)).toEqual({ scope: 'inspect' })
  expect(tool.review?.({ path: '/file' })).toMatchObject({ filePath: '/file' })
  expect(resolveToolScope(tool, {}, context)).toMatchObject({ scope: 'modify', reason: expect.stringContaining('工具参数无效') })
  expect(tool.review?.({})).toBeUndefined()
  expect(scope).toHaveBeenCalledOnce()
  expect(review).toHaveBeenCalledOnce()
})

test('merging tool sets replaces handler and declaration together', () => {
  const first = defineTools({ task: { description: 'First', schema: z.object({}), execute: () => 'first' } })
  const second = defineTools({ task: { description: 'Second', schema: z.object({}), execute: () => 'second' } })
  const merged = mergeTools(first, second)

  expect(merged.declarations).toHaveLength(1)
  expect(merged.declarations[0]?.description).toBe('Second')
  expect(merged.handlers.task?.execute({}, context)).toBe('second')
})

test('host services bind typed instances, preserve optional access and reject missing requirements', () => {
  const service = defineHostService<{ count: number }>('counter')
  const value = { count: 1 }
  const services = createHostServices([provideHostService(service, value)])
  const missing = defineHostService<string>('missing')

  expect(services.get(service)).toBe(value)
  expect(services.require(service).count).toBe(1)
  expect(services.get(missing)).toBeUndefined()
  expect(() => services.require(missing)).toThrow('宿主服务未注册: missing')
})
