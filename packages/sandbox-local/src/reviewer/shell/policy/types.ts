/** -------------------- 类型 -------------------- */
/** Shell 命令事实分类 */
export type ShellCommandCategory
  = | 'query'
    | 'check'
    | 'test'
    | 'build'
    | 'trustedExecution'
    | 'lockedRestore'
    | 'mutation'
    | 'externalEffect'
    | 'dangerous'
    | 'unknown'

/** Shell 命令事实评估 */
export interface ShellCommandAssessment {
  /** 命令事实分类 */
  category: ShellCommandCategory
  /** 面向审批或拒绝结果的原因 */
  reason?: string
}

/** Shell 命令评审使用的本地路径边界 */
export interface ShellReviewContext {
  /** 当前命令执行目录 */
  cwd: string
  /** 判断命令参数路径是否位于可信根内 */
  containsPath: (filePath: string, followLeaf?: boolean) => boolean
}

/** 单条命令策略 */
export interface ShellCommandPolicy {
  /** 策略稳定标识 */
  id: string
  /** 可执行文件 basename 或版本化名称模式 */
  executables: readonly (string | RegExp)[]
  /** 按 argv 和本地边界返回命令事实 */
  assess: (args: string[], context: ShellReviewContext) => ShellCommandAssessment
}
