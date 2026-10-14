import type { SandboxApprovalReview, SandboxScopeReview } from '@elmino/sandbox'
import type { ShellCommandAssessment, ShellCommandCategory } from './types.js'

/** -------------------- 常量 -------------------- */
/** 受限开发模式允许的命令类别 */
const PERMITTED_CATEGORIES = new Set<ShellCommandCategory>([
  'query',
  'check',
  'test',
  'build',
  'trustedExecution',
  'lockedRestore',
])

/** -------------------- 核心函数 -------------------- */
/**
 * 判断命令事实是否属于受限开发集合
 */
export function isPermittedShellAssessment(assessment: ShellCommandAssessment) {
  return PERMITTED_CATEGORIES.has(assessment.category)
}

/**
 * 将命令事实投影为普通审批决策
 */
export function projectApproval(assessment: ShellCommandAssessment): SandboxApprovalReview {
  if (isPermittedShellAssessment(assessment))
    return { decision: 'allow' }

  return assessment.category === 'unknown'
    ? { decision: 'unsure', reason: assessment.reason }
    : {
        decision: 'ask',
        reason: assessment.reason
          ? `${assessment.reason}，需要用户确认`
          : 'Shell 命令需要用户确认',
      }
}

/**
 * 将命令事实投影为允许进入的受限作用范围
 */
export function projectScope(assessment: ShellCommandAssessment): SandboxScopeReview {
  if (assessment.category === 'query' || assessment.category === 'check')
    return { scope: 'inspect' }

  if (isPermittedShellAssessment(assessment))
    return { scope: 'develop' }

  return {
    scope: 'modify',
    reason: assessment.reason ?? 'Shell 命令超出受限工具作用域',
  }
}
