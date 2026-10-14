import type { DefinedTool, DefinedTools } from '../types/types.js'
import { objectEntries, objectValues } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 合并多组工具，后传入的工具可覆盖同名工具处理器
 */
export function mergeTools(...tools: DefinedTools[]): DefinedTools {
  const handlers: Record<string, DefinedTool> = {}

  for (const item of tools) {
    for (const [name, tool] of objectEntries(item.handlers))
      handlers[name] = tool
  }

  const declarations = objectValues(handlers)
    .map(tool => tool.declaration)

  return {
    declarations,
    handlers,
  }
}
