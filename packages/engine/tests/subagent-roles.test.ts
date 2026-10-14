import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalSubagentRoles } from '@elmino/engine'
import { afterEach, expect, test } from 'vitest'
import {
  DEFAULT_SUBAGENT_ROLE_MARKDOWN,
  EXPLORER_SUBAGENT_ROLE_MARKDOWN,
  WORKER_SUBAGENT_ROLE_MARKDOWN,
} from '../src/prompts/constants/templates.js'

/** -------------------- 常量 -------------------- */
/** 测试结束后需要删除的临时角色目录 */
const temporaryDirs: string[] = []
/** 测试前的控制台告警函数 */
const originalWarn = console.warn
/** 需要真实 POSIX 权限语义且不能以 root 运行的测试入口 */
const permissionTest = process.platform !== 'win32' && process.getuid?.() !== 0
  ? test
  : test.skip

/** -------------------- 测试清理 -------------------- */
afterEach(async () => {
  console.warn = originalWarn
  await Promise.all(
    temporaryDirs.splice(0).map(dir => rm(dir, {
      force: true,
      recursive: true,
    })),
  )
})

/** -------------------- 辅助函数 -------------------- */
/**
 * 创建隔离的用户角色目录
 */
async function createRolesDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'elmino-agent-roles-'))

  temporaryDirs.push(dir)
  return dir
}

/**
 * 生成测试角色 Markdown
 */
function roleMarkdown(input: {
  name: string
  description: string
  icon: string
  instructions: string
}) {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    `icon: ${input.icon}`,
    '---',
    '',
    input.instructions,
    '',
  ].join('\n')
}

/** -------------------- 测试 -------------------- */
test('Subagent roles initialize missing builtin Markdown files', async () => {
  const root = await createRolesDir()
  const dir = path.join(root, 'roles')
  const store = LocalSubagentRoles.create({ dir })

  await store.initialize()

  expect(await Promise.all([
    readFile(path.join(dir, 'default.md'), 'utf8'),
    readFile(path.join(dir, 'explorer.md'), 'utf8'),
    readFile(path.join(dir, 'worker.md'), 'utf8'),
  ])).toEqual([
    DEFAULT_SUBAGENT_ROLE_MARKDOWN,
    EXPLORER_SUBAGENT_ROLE_MARKDOWN,
    WORKER_SUBAGENT_ROLE_MARKDOWN,
  ])
})

test('Subagent role initialization preserves edits and only fills missing builtins', async () => {
  const dir = await createRolesDir()
  const customDefault = roleMarkdown({
    name: '自定义通用',
    description: '保留用户修改',
    icon: 'bot',
    instructions: '使用用户自己的通用角色。',
  })

  await writeFile(path.join(dir, 'default.md'), customDefault)
  const store = LocalSubagentRoles.create({ dir })

  await store.initialize()

  expect(await readFile(path.join(dir, 'default.md'), 'utf8')).toBe(customDefault)
  expect(await readFile(path.join(dir, 'explorer.md'), 'utf8'))
    .toBe(EXPLORER_SUBAGENT_ROLE_MARKDOWN)
  expect(await readFile(path.join(dir, 'worker.md'), 'utf8'))
    .toBe(WORKER_SUBAGENT_ROLE_MARKDOWN)
})

test('Subagent role initialization recreates deleted builtins and remains idempotent', async () => {
  const dir = await createRolesDir()
  const explorerPath = path.join(dir, 'explorer.md')
  const store = LocalSubagentRoles.create({ dir })

  await store.initialize()
  await unlink(explorerPath)
  await store.initialize()

  expect(await readFile(explorerPath, 'utf8')).toBe(EXPLORER_SUBAGENT_ROLE_MARKDOWN)

  await store.initialize()
  expect(await readFile(explorerPath, 'utf8')).toBe(EXPLORER_SUBAGENT_ROLE_MARKDOWN)
})

test('Subagent role initialization preserves malformed builtin files and resolve falls back', async () => {
  const dir = await createRolesDir()
  const explorerPath = path.join(dir, 'explorer.md')
  const invalidExplorer = [
    '---',
    'name: 错误探索者',
    'description: 包含尚未支持的字段',
    'icon: compass',
    'tools: readFile',
    '---',
    '',
    '不要覆盖这份用户文件。',
  ].join('\n')
  const warnings: unknown[][] = []

  await writeFile(explorerPath, invalidExplorer)
  console.warn = (...args) => warnings.push(args)
  const store = LocalSubagentRoles.create({ dir })

  await store.initialize()
  const roles = await store.resolve()

  expect(await readFile(explorerPath, 'utf8')).toBe(invalidExplorer)
  expect(roles.find(role => role.id === 'explorer')?.name).toBe('探索者')
  expect(warnings[0]?.[0]).toContain('包含未支持字段: tools')
})

permissionTest('Subagent role initialization propagates non-conflict write failures', async () => {
  const dir = await createRolesDir()
  const store = LocalSubagentRoles.create({ dir })

  await chmod(dir, 0o500)

  try {
    await expect(store.initialize()).rejects.toMatchObject({ code: 'EACCES' })
  }
  finally {
    await chmod(dir, 0o700)
  }
})

test('Subagent roles keep builtin order and allow user roles to extend the catalog', async () => {
  const dir = await createRolesDir()

  await writeFile(path.join(dir, 'reviewer.md'), roleMarkdown({
    name: '审查者',
    description: '负责独立审查',
    icon: 'compass',
    instructions: '只返回审查结论。',
  }))

  const store = LocalSubagentRoles.create({ dir })
  await store.initialize()
  const roles = await store.resolve()

  expect(roles.map(role => role.id)).toEqual([
    'default',
    'explorer',
    'worker',
    'reviewer',
  ])
})

test('User role fully overrides builtin role and deletion restores builtin', async () => {
  const dir = await createRolesDir()
  const overridePath = path.join(dir, 'explorer.md')
  const roles = LocalSubagentRoles.create({ dir })

  await writeFile(overridePath, roleMarkdown({
    name: '资料员',
    description: '只查外部资料',
    icon: 'bot',
    instructions: '仅调研公开资料。',
  }))

  expect((await roles.resolve()).find(role => role.id === 'explorer')).toMatchObject({
    id: 'explorer',
    name: '资料员',
    description: '只查外部资料',
    icon: 'bot',
    instructions: '仅调研公开资料。',
  })

  await unlink(overridePath)
  expect((await roles.resolve()).find(role => role.id === 'explorer')?.name).toBe('探索者')
  await expect(readFile(overridePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Invalid user role is ignored as a whole and reports a warning', async () => {
  const dir = await createRolesDir()
  const warnings: unknown[][] = []

  await writeFile(path.join(dir, 'invalid.md'), [
    '---',
    'name: 无效角色',
    'description: 包含尚未支持的权限字段',
    'icon: bot',
    'tools: readFile',
    '---',
    '',
    '不要被加载。',
  ].join('\n'))

  console.warn = (...args) => warnings.push(args)
  const store = LocalSubagentRoles.create({ dir })
  const roles = await store.resolve()

  expect(roles.some(role => role.id === 'invalid')).toBe(false)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.[0]).toContain('包含未支持字段: tools')
})

test('Unknown role icon is rejected instead of silently falling back', async () => {
  const dir = await createRolesDir()
  const warnings: unknown[][] = []

  await writeFile(path.join(dir, 'invalid-icon.md'), roleMarkdown({
    name: '未知图标',
    description: '使用客户端未声明的图标',
    icon: 'rocket',
    instructions: '不要被加载。',
  }))

  console.warn = (...args) => warnings.push(args)
  const store = LocalSubagentRoles.create({ dir })
  const roles = await store.resolve()

  expect(roles.some(role => role.id === 'invalid-icon')).toBe(false)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.[0]).toContain('子智能体角色图标无效: rocket')
})

test('Subagent role catalog does not synthesize unknown roles', async () => {
  const dir = await createRolesDir()
  const store = LocalSubagentRoles.create({ dir })
  const roles = await store.resolve()

  expect(roles.some(role => role.id === 'missing')).toBe(false)
})

test('Role YAML preserves quoted punctuation and multiline descriptions', async () => {
  const dir = await createRolesDir()
  const store = LocalSubagentRoles.create({ dir })

  await writeFile(path.join(dir, 'research.md'), [
    '---',
    'name: "Research: evidence"',
    'description: |-',
    '  Compare sources',
    '  Preserve citations',
    'icon: compass',
    '---',
    '',
    'Read the complete source.',
  ].join('\n'))

  expect((await store.resolve()).find(role => role.id === 'research')).toEqual({
    id: 'research',
    name: 'Research: evidence',
    description: 'Compare sources\nPreserve citations',
    icon: 'compass',
    instructions: 'Read the complete source.',
  })
})

test('Malformed YAML cannot replace a builtin role', async () => {
  const dir = await createRolesDir()
  const warnings: unknown[][] = []
  const store = LocalSubagentRoles.create({ dir })

  await writeFile(path.join(dir, 'default.md'), '---\nname: [unterminated\n---\nDo not load')
  console.warn = (...args) => warnings.push(args)

  expect((await store.resolve()).find(role => role.id === 'default')?.name).toBe('通用')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.[0]).toContain('已忽略无效子智能体角色 default.md')
})
