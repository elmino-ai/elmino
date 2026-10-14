import type { LocalShellKind, SandboxReviewer, SandboxReviewInput } from '@elmino/sandbox'
import type { LocalSandboxPermissions } from '../filesystem/permissions'
import type { ShellReviewContext, ShellReviewer } from '../reviewer/index'
import path from 'node:path'
import {
  CmdReviewer,
  FileReviewer,
  PosixShellReviewer,
  PowershellReviewer,
  projectApproval,
  projectScope,
} from '../reviewer/index'

/** -------------------- 核心类 -------------------- */
/**
 * 组合本地运行环境的动作审批评审器
 */
export class LocalSandboxReviewer implements SandboxReviewer {
  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建本地沙箱审批评审器
   */
  public static create(permissions: LocalSandboxPermissions, cwd: string, shell: LocalShellKind) {
    const context = {
      cwd,
      containsPath: (filePath: string, followLeaf = true) => permissions.containsPath(
        path.resolve(cwd, filePath),
        followLeaf,
      ),
    }

    return new LocalSandboxReviewer(
      shell,
      context,
      PosixShellReviewer.getInstance(),
      CmdReviewer.getInstance(),
      PowershellReviewer.getInstance(),
      FileReviewer.create(permissions),
    )
  }

  /**
   * 保存不同执行面的审批评审器
   */
  private constructor(
    private readonly _shell: LocalShellKind,
    private readonly _context: ShellReviewContext,
    private readonly _posix: ShellReviewer,
    private readonly _cmd: ShellReviewer,
    private readonly _powershell: ShellReviewer,
    private readonly _files: FileReviewer,
  ) {}

  /**
   * 判断沙箱动作是否需要进入审批
   */
  public approval(input: SandboxReviewInput) {
    if (input.kind === 'shell') {
      if (typeof input.command !== 'string')
        return { decision: 'unsure' as const, reason: 'Shell 命令参数无效，需要用户确认' }

      return projectApproval(this._shellReviewer(input.shell).assess(input.command, this._context))
    }

    if (input.kind === 'internet') {
      return {
        decision: 'ask' as const,
        reason: input.url
          ? `访问网页 ${input.url} 需要用户确认`
          : '访问互联网网页需要用户确认',
      }
    }

    return this._files.approval(input)
  }

  /**
   * 判断沙箱动作允许进入的受限作用范围
   */
  public scope(input: SandboxReviewInput) {
    if (input.kind === 'shell') {
      if (typeof input.command !== 'string') {
        return {
          scope: 'modify' as const,
          reason: 'Shell 命令参数无效，无法确认工具作用域',
        }
      }

      return projectScope(this._shellReviewer(input.shell).assess(input.command, this._context))
    }

    if (input.kind === 'internet')
      return { scope: 'inspect' as const }

    return this._files.scope(input)
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 按显式或本地默认 Shell 读取命令评审器
   */
  private _shellReviewer(shell?: LocalShellKind) {
    const resolved = shell ?? this._shell

    if (resolved === 'cmd')
      return this._cmd

    return resolved === 'powershell' || resolved === 'pwsh'
      ? this._powershell
      : this._posix
  }
}
