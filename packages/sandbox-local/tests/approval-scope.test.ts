import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { projectApproval, projectScope } from '../src/reviewer/shell/policy/index.js'
import { createTestSandbox } from './support/sandbox.js'

/** -------------------- 常量 -------------------- */
/** 仅在 POSIX 主机执行的符号链接审批测试 */
const posixTest = process.platform === 'win32' ? test.skip : test

/** -------------------- 测试 -------------------- */
test('every inspect or develop command is also auto-approved', () => {
  const sandbox = createTestSandbox({ cwd: process.cwd(), shell: 'bash' })
  const commands = [
    'CI=1 git status --porcelain',
    '/usr/bin/ls -la | cat',
    'find . -name "*.ts"',
    'git branch --list',
    'git worktree list',
    'jq . package.json',
    'sha256sum package.json',
    'xcodebuild -version',
  ]

  for (const command of commands) {
    const input = { kind: 'shell' as const, command }
    const scope = sandbox.reviewer.scope(input)
    const approval = sandbox.reviewer.approval(input)

    expect(scope.scope, command).not.toBe('modify')
    expect(approval.decision, command).toBe('allow')
  }
})

test('known mutations ask in approval and resolve to modify scope', () => {
  const sandbox = createTestSandbox({ cwd: process.cwd(), shell: 'bash' })
  const commands = [
    'PATH=/tmp ls',
    'git diff --output=result.patch',
    'find . -delete',
    'sed -i s/a/b/ README.md',
    'rm -rf build',
    'mv source.txt target.txt',
  ]

  for (const command of commands) {
    const input = { kind: 'shell' as const, command }

    expect(sandbox.reviewer.approval(input).decision, command).toBe('ask')
    expect(sandbox.reviewer.scope(input).scope, command).toBe('modify')
  }
})

test('projects every assessment category with restricted scopes as an approval subset', () => {
  const categories = [
    'query',
    'check',
    'test',
    'build',
    'trustedExecution',
    'lockedRestore',
    'mutation',
    'externalEffect',
    'dangerous',
    'unknown',
  ] as const

  for (const category of categories) {
    const scope = projectScope({ category })
    const approval = projectApproval({ category })

    if (scope.scope !== 'modify')
      expect(approval.decision, category).toBe('allow')
    else
      expect(approval.decision, category).not.toBe('allow')
  }
})

test('file mutations inside cwd bypass approval without trusting other writable roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-file-approval-'))

  try {
    const workspace = path.join(root, 'workspace')
    const allowedRoot = path.join(root, 'runtime-data')
    const outsideFile = path.join(root, 'outside', 'note.md')
    const insideFile = path.join(workspace, 'src', 'main.ts')
    const allowedFile = path.join(allowedRoot, 'config.json')

    await mkdir(path.dirname(insideFile), { recursive: true })
    await mkdir(allowedRoot, { recursive: true })
    await writeFile(insideFile, 'export {}\n', 'utf8')
    await writeFile(allowedFile, '{}\n', 'utf8')

    const sandbox = createTestSandbox({ cwd: workspace, allowedRoots: [allowedRoot] })
    const allowedCases = [
      { action: 'write' as const, filePath: 'generated/new.ts' },
      { action: 'edit' as const, filePath: insideFile },
      { action: 'remove' as const, filePath: 'src/main.ts' },
    ]

    for (const input of allowedCases) {
      expect(sandbox.reviewer.approval({ kind: 'file', ...input })).toEqual({
        decision: 'allow',
      })
    }

    expect(sandbox.reviewer.approval({
      kind: 'file',
      action: 'remove',
      filePath: '.',
    }).decision).toBe('ask')

    const allowedRootReview = sandbox.reviewer.approval({
      kind: 'file',
      action: 'edit',
      filePath: allowedFile,
    })

    expect(allowedRootReview.decision).toBe('ask')
    expect(allowedRootReview.grants).toBeUndefined()

    const outsideReview = sandbox.reviewer.approval({
      kind: 'file',
      action: 'write',
      filePath: outsideFile,
    })

    expect(outsideReview.decision).toBe('ask')
    expect(outsideReview.grants).toEqual([outsideFile])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

posixTest('file approval follows symlink parents without blocking link removal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-file-approval-link-'))

  try {
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    const outsideFile = path.join(outside, 'existing.ts')
    const link = path.join(workspace, 'outside-link')

    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(outsideFile, 'export {}\n', 'utf8')
    await symlink(outside, link, 'dir')

    const sandbox = createTestSandbox(workspace)
    const escapedCases = [
      { action: 'write' as const, filePath: 'outside-link/new.ts' },
      { action: 'edit' as const, filePath: 'outside-link/existing.ts' },
      { action: 'remove' as const, filePath: 'outside-link/existing.ts' },
    ]

    for (const input of escapedCases) {
      expect(sandbox.reviewer.approval({ kind: 'file', ...input }).decision)
        .toBe('ask')
    }

    expect(sandbox.reviewer.approval({
      kind: 'file',
      action: 'remove',
      filePath: 'outside-link',
    })).toEqual({ decision: 'allow' })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
