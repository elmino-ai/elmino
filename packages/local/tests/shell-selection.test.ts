import type * as NodeFs from 'node:fs'
import { createEnv, findEnvExecutable, findEnvExecutableSync, listLocalShells, resolveLocalShell } from '@elmino/local'
import { beforeEach, expect, test, vi } from 'vitest'

/** -------------------- 测试替身 -------------------- */
const filesystem = vi.hoisted(() => ({
  files: new Set<string>(),
  denied: new Set<string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()

  return {
    ...original,
    accessSync: (filePath: string) => {
      if (!filesystem.files.has(filePath) || filesystem.denied.has(filePath))
        throw new Error(`EACCES: ${filePath}`)
    },
    statSync: (filePath: string) => {
      if (!filesystem.files.has(filePath))
        throw new Error(`ENOENT: ${filePath}`)

      return { isFile: () => true }
    },
  }
})

vi.mock('node:fs/promises', () => ({
  stat: (filePath: string) => {
    if (!filesystem.files.has(filePath))
      return Promise.reject(new Error(`ENOENT: ${filePath}`))
    return Promise.resolve({ isFile: () => true })
  },
  access: (filePath: string) => {
    if (!filesystem.files.has(filePath) || filesystem.denied.has(filePath))
      return Promise.reject(new Error(`EACCES: ${filePath}`))
    return Promise.resolve()
  },
}))

/** -------------------- 测试 -------------------- */
beforeEach(() => {
  filesystem.files.clear()
  filesystem.denied.clear()
})

test('Windows 自动优先 PowerShell 7 并按固定顺序降级', () => {
  const env = createEnv({
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    Path: 'C:\\Tools',
  })

  filesystem.files.add('C:\\Tools\\pwsh.exe')
  filesystem.files.add('C:\\Tools\\powershell.exe')
  filesystem.files.add('C:\\Windows\\System32\\cmd.exe')
  expect(resolveLocalShell({ env, platform: 'win32' })).toEqual({
    kind: 'pwsh',
    path: 'C:\\Tools\\pwsh.exe',
  })

  filesystem.files.delete('C:\\Tools\\pwsh.exe')
  expect(resolveLocalShell({ env, platform: 'win32' }).kind).toBe('powershell')

  filesystem.files.delete('C:\\Tools\\powershell.exe')
  expect(resolveLocalShell({ env, platform: 'win32' })).toEqual({
    kind: 'cmd',
    path: 'C:\\Windows\\System32\\cmd.exe',
  })
})

test('Windows 会从系统固定位置查找 PowerShell', () => {
  const env = createEnv({ Path: 'C:\\Missing' })

  filesystem.files.add('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  expect(resolveLocalShell({ env, platform: 'win32' })).toEqual({
    kind: 'pwsh',
    path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  })

  filesystem.files.clear()
  filesystem.files.add('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(resolveLocalShell({ env, platform: 'win32' })).toEqual({
    kind: 'powershell',
    path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  })
})

test('Windows 所选 PowerShell 7 缺失时使用 Windows PowerShell，再回退到 cmd', () => {
  const env = createEnv({
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    Path: 'C:\\Tools',
  })

  filesystem.files.add('C:\\Windows\\System32\\cmd.exe')
  filesystem.files.add('C:\\Tools\\powershell.exe')
  expect(resolveLocalShell({ env, fallback: true, platform: 'win32', preference: 'pwsh' })).toEqual({
    kind: 'powershell',
    path: 'C:\\Tools\\powershell.exe',
  })

  filesystem.files.delete('C:\\Tools\\powershell.exe')
  expect(resolveLocalShell({ env, fallback: true, platform: 'win32', preference: 'pwsh' })).toEqual({
    kind: 'cmd',
    path: 'C:\\Windows\\System32\\cmd.exe',
  })

  filesystem.files.clear()
  expect(() => resolveLocalShell({
    env,
    fallback: true,
    platform: 'win32',
    preference: 'pwsh',
  })).toThrow('未找到已配置的命令 Shell：pwsh')
})

test('Windows 工具显式指定缺失的 Shell 时不回退到其他语法', () => {
  const env = createEnv({ Path: 'C:\\Tools' })

  filesystem.files.add('C:\\Tools\\powershell.exe')
  expect(() => resolveLocalShell({
    env,
    platform: 'win32',
    preference: 'pwsh',
  })).toThrow('未找到已配置的命令 Shell：pwsh')
})

test('Windows 优先保留可用的显式选择', () => {
  const env = createEnv({ Path: 'C:\\Tools' })

  filesystem.files.add('C:\\Tools\\pwsh.exe')
  filesystem.files.add('C:\\Tools\\powershell.exe')
  expect(resolveLocalShell({ env, fallback: true, platform: 'win32', preference: 'powershell' })).toEqual({
    kind: 'powershell',
    path: 'C:\\Tools\\powershell.exe',
  })
})

test('工具显式指定缺失的 POSIX Shell 时仍报告错误', () => {
  const env = createEnv({ PATH: '/bin' })

  filesystem.files.add('/bin/sh')
  expect(() => resolveLocalShell({
    accountShell: null,
    env,
    platform: 'linux',
    preference: 'bash',
  })).toThrow('未找到已配置的命令 Shell：bash')
})

test('macOS 自动按 zsh、bash、sh 选择，不受账户 Shell 类型影响', () => {
  const env = createEnv({ PATH: '/bin' })
  const options = { accountShell: '/bin/bash', env, platform: 'darwin' as const }

  filesystem.files.add('/bin/zsh')
  filesystem.files.add('/bin/bash')
  filesystem.files.add('/bin/sh')
  expect(resolveLocalShell(options)).toEqual({ kind: 'zsh', path: '/bin/zsh' })

  filesystem.files.delete('/bin/zsh')
  expect(resolveLocalShell(options)).toEqual({ kind: 'bash', path: '/bin/bash' })

  filesystem.files.delete('/bin/bash')
  expect(resolveLocalShell(options)).toEqual({ kind: 'sh', path: '/bin/sh' })

  filesystem.files.clear()
  expect(() => resolveLocalShell(options)).toThrow('当前系统没有可用的命令 Shell')
})

test.each(['darwin', 'linux'] as const)('平台 %s 的默认选择缺失时也允许回退', (platform) => {
  const env = createEnv({ PATH: '/bin' })

  filesystem.files.add('/bin/sh')
  expect(resolveLocalShell({
    accountShell: null,
    env,
    fallback: true,
    platform,
    preference: 'zsh',
  })).toEqual({ kind: 'sh', path: '/bin/sh' })
})

test('自动模式不返回未经检测的兜底程序名', () => {
  const env = createEnv({ PATH: '/missing' })

  expect(() => resolveLocalShell({
    accountShell: null,
    env,
    platform: 'linux',
  })).toThrow('当前系统没有可用的命令 Shell')
})

test('macOS 命令 Shell 选择不改变账户 Shell 加载出的环境', () => {
  const env = createEnv({
    CONDA_DEFAULT_ENV: 'base',
    CONDA_PREFIX: '/opt/conda',
    PATH: '/opt/conda/bin:/bin:/usr/bin',
  })

  filesystem.files.add('/bin/zsh')
  filesystem.files.add('/bin/bash')
  filesystem.files.add('/bin/sh')
  expect(resolveLocalShell({
    accountShell: '/bin/zsh',
    env,
    platform: 'darwin',
  })).toEqual({ kind: 'zsh', path: '/bin/zsh' })
  expect(resolveLocalShell({
    accountShell: '/bin/zsh',
    env,
    platform: 'darwin',
    preference: 'bash',
  })).toEqual({ kind: 'bash', path: '/bin/bash' })
  expect(env).toMatchObject({
    CONDA_DEFAULT_ENV: 'base',
    CONDA_PREFIX: '/opt/conda',
  })
})

test('Shell 列表只返回当前平台选项并标记缺失项', () => {
  const env = createEnv({ PATH: '/bin:/usr/bin' })

  filesystem.files.add('/bin/bash')
  filesystem.files.add('/bin/sh')
  expect(listLocalShells({ accountShell: null, env, platform: 'linux' })).toEqual([
    { kind: 'bash', path: '/bin/bash' },
    { kind: 'zsh' },
    { kind: 'sh', path: '/bin/sh' },
  ])
})

test('Windows Path 和自定义 PathExt 按不区分大小写规则查找且保留已有扩展名', async () => {
  filesystem.files.add('C:\\Tools\\custom.script')
  const env = { pAtH: 'C:\\Tools', PathExt: '.SCRIPT' }

  expect(await findEnvExecutable('custom', env, 'win32')).toBe('C:\\Tools\\custom.script')
  expect(findEnvExecutableSync('custom', env, 'win32')).toBe('C:\\Tools\\custom.script')
  expect(findEnvExecutableSync('custom.script', env, 'win32')).toBe('C:\\Tools\\custom.script')
  expect(findEnvExecutableSync('custom', { PATH: 'C:\\Missing', PathExt: '.SCRIPT' }, 'win32')).toBeUndefined()
})

test('POSIX 账户路径和固定路径都必须具备执行权限', () => {
  filesystem.files.add('/custom/bash')
  filesystem.files.add('/bin/bash')
  filesystem.files.add('/bin/sh')
  filesystem.denied.add('/custom/bash')
  filesystem.denied.add('/bin/bash')

  expect(listLocalShells({ accountShell: '/custom/bash', env: {}, platform: 'linux' })).toEqual([
    { kind: 'bash' },
    { kind: 'zsh' },
    { kind: 'sh', path: '/bin/sh' },
  ])
  expect(() => resolveLocalShell({ accountShell: '/custom/bash', env: {}, platform: 'linux', preference: 'bash' }))
    .toThrow('未找到已配置的命令 Shell：bash')
})

test('显式选择跨平台不支持的 Shell 时即使允许回退也报错', () => {
  expect(() => resolveLocalShell({ accountShell: null, env: {}, platform: 'linux', preference: 'cmd', fallback: true }))
    .toThrow('当前平台不支持命令 Shell：cmd')
})
