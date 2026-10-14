import type { EnvVars, LocalShell, Sandbox } from '@elmino/sandbox'

/** 工作区的项目归属类型 */
export type WorkspaceKind = 'managed' | 'project'

/** 线程稳定存储作用域与实际执行位置 */
export interface ThreadLocation {
  /** 稳定存储作用域 */
  readonly workspaceId: string
  /** 当前项目的目录归属类型 */
  readonly workspaceKind: WorkspaceKind
  /** 项目资产根目录 */
  readonly workspaceRoot: string
  /** 相对项目根目录的线程执行目录 */
  readonly dir: string
  /** 当前线程实际执行目录 */
  readonly cwd: string
}

/** Runtime 创建上下文 */
export interface RuntimeCreateContext {
  /** 当前线程固定所属的 Agent */
  agentId: string
  /** 当前线程稳定存储作用域与实际执行位置 */
  location: ThreadLocation
  /** 宿主冻结的执行环境，远程 Runtime 可以省略 */
  env?: EnvVars
  /** 宿主冻结的默认命令 Shell，远程 Runtime 可以省略 */
  shell?: LocalShell
}

/** 创建线程运行能力的入口 */
export type RuntimeCreator = (context: RuntimeCreateContext) => Runtime

/** Runtime 定义 */
export interface RuntimeDefinition {
  /** 创建线程 Runtime */
  create: RuntimeCreator
}

/** 线程执行能力与资源生命周期 */
export interface Runtime {
  /** 当前线程稳定作用域与执行位置 */
  readonly location: ThreadLocation
  /** 返回执行环境 */
  sandbox: () => Sandbox
  /** 等待执行资源释放，重复关闭幂等 */
  dispose: () => Promise<void>
}
