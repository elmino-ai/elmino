/** -------------------- 类型 -------------------- */
/** 工具参数校验问题 */
export interface ToolArgsIssue {
  /** 参数字段路径 */
  path: PropertyKey[]
  /** 校验失败原因 */
  message: string
}

/** -------------------- 核心函数 -------------------- */
/**
 * 格式化工具参数校验问题
 */
export function formatToolArgsIssues(
  issues: readonly ToolArgsIssue[],
) {
  return issues
    .map(issue => `${issue.path.join('.') || 'args'}: ${issue.message}`)
    .join('; ')
}
