import { createEnv, LocalEnv, resolvePathKey } from '@elmino/local'
import { expect, test, vi } from 'vitest'

test('createEnv 复制字符串变量，保留空值并冻结快照', () => {
  const input = { EMPTY: '', VALUE: 'before', MISSING: undefined }
  const env = createEnv(input)

  input.VALUE = 'after'
  expect(env).toEqual({ EMPTY: '', VALUE: 'before' })
  expect(Object.isFrozen(env)).toBe(true)
})

test('应用层和启动层依次覆盖 Shell，已交付的环境保持不变', () => {
  const shell = { PATH: '/shell/bin', VALUE: 'shell' }
  const launch = { VALUE: 'launch' }
  const env = LocalEnv.create({ shell, launch, platform: 'linux' })
  const original = env.snapshot()
  const variables = { VALUE: 'application', EXTRA: 'present' }
  const prependPath = ['/managed/bin']

  env.setApplicationLayer({ variables, prependPath, appendPath: ['/last/bin'] })
  const current = env.snapshot()

  shell.PATH = '/mutated'
  launch.VALUE = 'mutated'
  variables.EXTRA = 'mutated'
  prependPath.push('/mutated')
  expect(current).toEqual({ PATH: '/managed/bin:/shell/bin:/last/bin', VALUE: 'launch', EXTRA: 'present' })
  expect(env.snapshot()).toBe(current)
  expect(original).toEqual({ PATH: '/shell/bin', VALUE: 'launch' })
  expect(Object.isFrozen(current)).toBe(true)
})

test('启动层 PATH 完整覆盖应用 PATH，POSIX 的其他变量区分大小写', () => {
  const env = LocalEnv.create({
    shell: { PATH: '/shell', KEY: 'upper', key: 'lower' },
    launch: { PATH: '/launch' },
    platform: 'linux',
  })

  env.setApplicationLayer({ prependPath: ['/application'], variables: { key: 'application' } })
  expect(env.snapshot()).toEqual({ PATH: '/launch', KEY: 'upper', key: 'application' })
})

test('Windows 环境变量按大小写合并，PATH 按平台规则去重', () => {
  const env = LocalEnv.create({
    platform: 'win32',
    shell: { Path: 'C:\\Tools;C:\\Managed;C:\\Windows', TOKEN: 'shell' },
    launch: { token: 'launch' },
  })

  env.setApplicationLayer({
    prependPath: ['c:\\managed', 'D:\\Runtime'],
    appendPath: ['c:\\tools'],
    variables: { Token: 'application' },
  })
  expect(env.snapshot()).toEqual({
    Path: 'c:\\managed;D:\\Runtime;C:\\Tools;C:\\Windows',
    TOKEN: 'launch',
  })
  expect(resolvePathKey(env.snapshot(), 'win32')).toBe('Path')
})

test('Windows 启动层不同大小写的 PATH 仍是最终覆盖', () => {
  const env = LocalEnv.create({
    platform: 'win32',
    shell: { Path: 'C:\\Original' },
    launch: { PATH: 'D:\\Launch' },
  })

  env.setApplicationLayer({ prependPath: ['C:\\Application'] })
  expect(env.snapshot()).toEqual({ Path: 'D:\\Launch' })
})

test('并发刷新共享一次加载，并在完成时保留最新应用层', async () => {
  const pending = Promise.withResolvers<Readonly<Record<string, string>>>()
  const loadShell = vi.fn(() => pending.promise)
  const env = LocalEnv.create({
    platform: 'linux',
    shell: { PATH: '/old', VALUE: 'old' },
    launch: { OVERRIDE: 'launch' },
    loadShell,
  })
  const original = env.snapshot()
  const first = env.refresh()
  const second = env.refresh()

  env.setApplicationLayer({ variables: { LATEST: 'application' } })
  pending.resolve(createEnv({ PATH: '/new', VALUE: 'new' }))
  const current = await first

  expect(second).toBe(first)
  expect(await second).toBe(current)
  expect(loadShell).toHaveBeenCalledTimes(1)
  expect(current).toEqual({ PATH: '/new', VALUE: 'new', LATEST: 'application', OVERRIDE: 'launch' })
  expect(original).toEqual({ PATH: '/old', VALUE: 'old', OVERRIDE: 'launch' })
  expect(env.snapshot()).toBe(current)
})

test('刷新失败保留现有快照，后续可以再次刷新', async () => {
  const loadShell = vi.fn()
    .mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValueOnce(createEnv({ PATH: '/recovered' }))
  const env = LocalEnv.create({ shell: { PATH: '/old' }, loadShell, platform: 'linux' })
  const original = env.snapshot()

  await expect(env.refresh()).rejects.toThrow('读取失败')
  expect(env.snapshot()).toBe(original)
  await expect(env.refresh()).resolves.toEqual({ PATH: '/recovered' })
  expect(loadShell).toHaveBeenCalledTimes(2)
})

test('同步加载异常也拒绝刷新且不会污染快照', async () => {
  const env = LocalEnv.create({
    shell: { PATH: '/old' },
    platform: 'linux',
    loadShell: () => { throw new Error('同步失败') },
  })

  await expect(env.refresh()).rejects.toThrow('同步失败')
  expect(env.snapshot()).toEqual({ PATH: '/old' })
})

test('没有加载器的刷新返回当前快照', async () => {
  const env = LocalEnv.create({ shell: { PATH: '/unchanged' }, platform: 'linux' })

  expect(await env.refresh()).toBe(env.snapshot())
})
