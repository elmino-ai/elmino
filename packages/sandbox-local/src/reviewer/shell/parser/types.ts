import type { ShellCommandAssessment, ShellReviewContext } from '../policy/types'

/** -------------------- 类型 -------------------- */
/** Shell 语法解析与命令事实评审器 */
export interface ShellReviewer {
  /** 解析命令并返回与审批模式无关的事实分类 */
  assess: (input: string, context: ShellReviewContext) => ShellCommandAssessment
}
