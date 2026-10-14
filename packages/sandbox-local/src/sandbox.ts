import type {
  EnvVars,
  LocalShell,
  LocalShellResolver,
  Sandbox,
  SandboxEnv,
  SandboxFiles,
  SandboxInternet,
  SandboxReviewer,
  SandboxShell,
} from '@elmino/sandbox'
import path from 'node:path'
import { LocalSandboxFiles } from './filesystem/files.js'
import { LocalSandboxPermissions } from './filesystem/permissions.js'
import { LocalSandboxReviewer } from './review/reviewer.js'
import { LocalSandboxShell } from './shell/shell.js'

/** -------------------- 类型 -------------------- */
/** 本地沙箱初始化参数 */
export interface LocalSandboxOptions {
  /** 命令默认执行目录 */
  cwd: string
  /** 当前 Runtime 冻结的执行环境 */
  env: EnvVars
  /** 当前 Runtime 冻结的本地默认 Shell */
  shell: LocalShell
  /** 文件系统额外允许访问的根目录 */
  allowedRoots?: string[]
  /** 宿主提供的额外命令解释器解析能力 */
  resolveShell?: LocalShellResolver
}

/** 本地 Sandbox 完整装配参数 */
interface LocalSandboxContext {
  /** 命令默认执行目录 */
  cwd: string
  /** 本地默认 Shell */
  defaultShell: LocalShell
  /** 当前 Runtime 冻结的执行环境 */
  env: EnvVars
  /** 允许直接写入的本地根目录 */
  roots: string[]
  /** 本次临时写入授权 */
  grants: string[]
  /** 派生实例共享的 Shell */
  shell: SandboxShell
}

/** -------------------- 核心类 -------------------- */
/**
 * 基于本地工作目录组合沙箱执行环境
 */
export class LocalSandbox implements Sandbox {
  /** 命令默认执行目录 */
  private readonly _cwd: string

  /** 本地默认 Shell */
  private readonly _shell: LocalShell

  /** 允许直接写入的本地根目录 */
  private readonly _roots: string[]

  /** 本次临时写入授权 */
  private readonly _grants: string[]

  /** 当前 Runtime 冻结的进程环境 */
  private readonly _env: EnvVars

  /** 文件系统能力 */
  public readonly files: SandboxFiles

  /** 互联网基础能力 */
  public readonly internet: SandboxInternet

  /** 命令执行能力 */
  public readonly shell: SandboxShell

  /** 审批预检能力 */
  public readonly reviewer: SandboxReviewer

  /** 当前命令和文件工具实际使用的执行环境 */
  public readonly env: SandboxEnv

  /** -------------------- 核心方法 -------------------- */
  /**
   * 返回本地执行环境
   */
  public static create(options: LocalSandboxOptions) {
    const { allowedRoots = [], cwd: inputCwd, env, shell: defaultShell } = options
    const cwd = path.resolve(inputCwd)
    const roots = allowedRoots.map(root => path.resolve(root))
    const grants: string[] = []
    const shell = LocalSandboxShell.create(cwd, defaultShell, env, options.resolveShell)

    return new LocalSandbox({ cwd, defaultShell, env, roots, grants, shell })
  }

  /**
   * 返回带本次临时写入授权的新沙箱
   */
  public withGrants(paths: string[]) {
    if (paths.length === 0)
      return this

    const cwd = this._cwd
    const defaultShell = this._shell
    const env = this._env
    const roots = this._roots
    const grants = [...this._grants, ...paths]
    const shell = this.shell

    return new LocalSandbox({ cwd, defaultShell, env, roots, grants, shell })
  }

  /**
   * 保存命令目录和文件访问边界
   */
  private constructor(context: LocalSandboxContext) {
    const {
      cwd,
      defaultShell,
      env,
      grants: inputGrants,
      roots: inputRoots,
      shell,
    } = context
    const roots = [...new Set([cwd, ...inputRoots].map(root => path.resolve(root)))]
    const grants = [...new Set(inputGrants.map(filePath => path.resolve(filePath)))]
    const permissions = LocalSandboxPermissions.create(cwd, roots, grants)
    this._cwd = cwd
    this._shell = defaultShell
    this._roots = roots
    this._grants = grants
    this._env = env
    this.env = { cwd, platform: process.platform, shell: defaultShell.kind }
    this.reviewer = LocalSandboxReviewer.create(permissions, cwd, defaultShell.kind)
    this.files = LocalSandboxFiles.create(permissions, cwd, env)
    this.internet = {
      fetch: (...args) => globalThis.fetch(...args),
    }
    this.shell = shell
  }
}
