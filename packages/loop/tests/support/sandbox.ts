import type {
  Sandbox,
  SandboxApprovalReview,
  SandboxFiles,
  SandboxInternet,
  SandboxReviewInput,
  SandboxScopeReview,
  SandboxShell,
} from '@elmino/sandbox'

/**
 * 创建测试用沙箱能力
 */
export function createMockSandbox(input: {
  /** 当前工具实际执行目录 */
  cwd?: string
  /** 文件能力覆盖 */
  files?: Partial<SandboxFiles>
  /** 互联网能力覆盖 */
  internet?: Partial<SandboxInternet>
  /** 工具作用范围评审覆盖 */
  scope?: (input: SandboxReviewInput) => SandboxScopeReview
  /** shell 执行覆盖 */
  run?: SandboxShell['run']
  /** shell 会话写入覆盖 */
  write?: SandboxShell['write']
  /** 自定义 Shell terminate */
  terminate?: SandboxShell['terminate']
  /** 自定义 Shell dispose */
  dispose?: SandboxShell['dispose']
} = {}): Sandbox {
  /** 模拟本地审批分类 */
  const approval = (input: SandboxReviewInput): SandboxApprovalReview => {
    if (input.kind === 'shell') {
      return {
        decision: input.command?.includes('rm') ? 'ask' : 'allow',
        reason: 'Shell 命令需要用户确认',
      }
    }

    if (input.kind === 'internet') {
      return {
        decision: 'ask',
        reason: '互联网访问需要用户确认',
      }
    }

    return {
      decision: ['write', 'remove', 'edit'].includes(input.action) ? 'ask' : 'allow',
      reason: '文件动作需要用户确认',
      grants: input.filePath?.startsWith('/outside/')
        ? [input.filePath]
        : undefined,
    }
  }
  /** 模拟沙箱动作的工具作用范围 */
  const scope = (review: SandboxReviewInput): SandboxScopeReview => {
    if (review.kind === 'shell') {
      return review.command?.includes('rm')
        ? { scope: 'modify', reason: 'Shell 命令会修改状态' }
        : { scope: 'inspect' }
    }

    if (review.kind === 'internet')
      return { scope: 'inspect' }

    return ['write', 'remove', 'edit'].includes(review.action)
      ? { scope: 'modify', reason: '文件动作会修改状态' }
      : { scope: 'inspect' }
  }
  /** 默认 Shell dispose */
  const dispose = input.dispose ?? (() => Promise.resolve())
  const sandbox: Sandbox = {
    env: {
      cwd: input.cwd ?? '/workspace',
      platform: 'test',
      shell: 'bash',
    },
    files: {
      exists: () => Promise.resolve(false),
      list: () => Promise.resolve({ files: [] }),
      read: () => Promise.resolve({ content: '' }),
      readBytes: () => Promise.resolve(new Uint8Array()),
      write: filePath => Promise.resolve({ path: filePath }),
      writeBytes: filePath => Promise.resolve({ path: filePath }),
      remove: filePath => Promise.resolve({ path: filePath }),
      move: (_source, target) => Promise.resolve({ path: target }),
      edit: filePath => Promise.resolve({ path: filePath, occurrences: 0 }),
      glob: () => Promise.resolve({ files: [] }),
      grep: () => Promise.resolve({ matches: [] }),
      ...input.files,
    },
    shell: {
      run: input.run
        ?? (command => Promise.resolve({ status: 'exited', output: command, exitCode: 0 })),
      write: input.write
        ?? (() => Promise.reject(new Error('测试 Shell 会话不存在'))),
      terminate: input.terminate
        ?? (() => Promise.reject(new Error('测试 Shell 会话不存在'))),
      dispose,
    },
    internet: {
      fetch: (request, init) => globalThis.fetch(request, init),
      ...input.internet,
    },
    reviewer: {
      approval,
      scope: input.scope ?? scope,
    },
    withGrants: () => sandbox,
  }

  return sandbox
}
