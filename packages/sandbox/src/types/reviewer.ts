import type { SandboxFileReviewInput } from './file'
import type { SandboxInternetReviewInput } from './internet'
import type { SandboxShellReviewInput } from './shell'

/** -------------------- 类型 -------------------- */
/** 沙箱审批预检结果 */
export interface SandboxApprovalReview {
  /** 预检审批决策 */
  decision: 'allow' | 'ask' | 'unsure'
  /** 需要审批时展示给用户或评审模型的原因 */
  reason?: string
  /** 审批通过后本次工具调用临时放行的路径 */
  grants?: string[]
}

/** 沙箱动作供受限策略匹配的作用范围 */
export type SandboxScope = 'inspect' | 'develop' | 'modify'

/** 沙箱动作互斥返回调研/开发范围，或带原因的修改范围 */
export type SandboxScopeReview
  = | {
    /** 本次动作属于受限模式可直接允许的调研或开发范围 */
    scope: Exclude<SandboxScope, 'modify'>
    /** 调研和开发范围不携带拒绝原因 */
    reason?: never
  }
  | {
    /** 本次动作属于修改范围 */
    scope: 'modify'
    /** 修改范围被当前限制拒绝时返回给模型的原因 */
    reason: string
  }

/** 沙箱审批预检输入 */
export type SandboxReviewInput
  = | SandboxShellReviewInput
    | SandboxInternetReviewInput
    | SandboxFileReviewInput

/** 沙箱动作审批评审器 */
export interface SandboxReviewer {
  /** 判断动作是否需要进入审批 */
  approval: (input: SandboxReviewInput) => SandboxApprovalReview
  /** 判断动作允许进入的受限作用范围 */
  scope: (input: SandboxReviewInput) => SandboxScopeReview
}
