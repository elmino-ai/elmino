import type { DefinedTool, ToolExecutionContext, ToolScopeReview } from '../types/types.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 解析单次工具调用允许进入的受限作用范围
 */
export function resolveToolScope(
  tool: DefinedTool,
  args: unknown,
  context: ToolExecutionContext,
): ToolScopeReview {
  if (!tool.scope) {
    return {
      scope: 'modify',
      reason: '工具未声明受限作用范围',
    }
  }
  if (tool.scope === 'modify') {
    return {
      scope: 'modify',
      reason: '工具声明为修改型作用范围',
    }
  }
  if (typeof tool.scope !== 'function')
    return { scope: tool.scope }

  return tool.scope(args, context)
}
