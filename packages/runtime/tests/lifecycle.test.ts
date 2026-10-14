import type { ThreadLocation } from '@elmino/runtime'
import type { Sandbox } from '@elmino/sandbox'
import { defineRuntime, LocalRuntime } from '@elmino/runtime/local'
import { expect, test, vi } from 'vitest'

/** 明确注入的线程执行位置 */
const location: ThreadLocation = {
  workspaceId: 'workspace_test',
  workspaceKind: 'project',
  workspaceRoot: '/workspace',
  dir: 'src',
  cwd: '/workspace/src',
}

test('runtime factory forwards creation context and freezes its owned execution location', () => {
  const sandbox = { shell: { dispose: vi.fn() } } as unknown as Sandbox
  const createSandbox = vi.fn(() => sandbox)
  const definition = defineRuntime(createSandbox)
  const input = { agentId: 'agent_test', location: { ...location } }
  const runtime = definition.create(input)

  input.location.cwd = '/other'
  expect(createSandbox).toHaveBeenCalledWith(input)
  expect(runtime.location.cwd).toBe('/workspace/src')
  expect(Object.isFrozen(runtime.location)).toBe(true)
  expect(runtime.sandbox()).toBe(sandbox)
})

test('runtime shutdown shares one promise, waits for owned shell and rejects new access', async () => {
  let release!: () => void
  const finishing = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispose = vi.fn(() => finishing)
  const sandbox = { shell: { dispose } } as unknown as Sandbox
  const runtime = LocalRuntime.create({ location, sandbox })
  const closing = runtime.dispose()

  expect(runtime.dispose()).toBe(closing)
  expect(() => runtime.sandbox()).toThrow('Runtime 执行环境已经关闭')
  await Promise.resolve()
  expect(dispose).toHaveBeenCalledOnce()
  release()
  await closing
  expect(runtime.dispose()).toBe(closing)
})

test('runtime preserves shutdown failure and does not release a second owner', async () => {
  const error = new Error('shell shutdown failed')
  const dispose = vi.fn(() => Promise.reject(error))
  const runtime = LocalRuntime.create({ location, sandbox: { shell: { dispose } } as unknown as Sandbox })

  await expect(runtime.dispose()).rejects.toBe(error)
  await expect(runtime.dispose()).rejects.toBe(error)
  expect(dispose).toHaveBeenCalledOnce()
})
