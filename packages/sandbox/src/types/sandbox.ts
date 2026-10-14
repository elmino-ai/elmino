import type { SandboxFiles } from './file'
import type { SandboxInternet } from './internet'
import type { LocalShellKind } from './local'
import type { SandboxReviewer } from './reviewer'
import type { SandboxShell } from './shell'

/** -------------------- 类型 -------------------- */
/** 沙箱公开给模型的执行环境 */
export interface SandboxEnv {
  /** 命令默认执行目录 */
  cwd: string
  /** 宿主平台标识 */
  platform: string
  /** 默认命令解释器 */
  shell: LocalShellKind
}

/** 统一执行环境 */
export interface Sandbox {
  /** 当前命令和文件工具实际使用的执行环境 */
  env: SandboxEnv
  /** 文件系统能力 */
  files: SandboxFiles
  /** 互联网基础能力 */
  internet: SandboxInternet
  /** 命令执行能力 */
  shell: SandboxShell
  /** 审批预检能力 */
  reviewer: SandboxReviewer
  /** 返回带本次临时写入授权的新沙箱 */
  withGrants: (paths: string[]) => Sandbox
}
