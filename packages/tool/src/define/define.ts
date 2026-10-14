import type { UnknownRecord } from '@elmino/shared'
import type { DefinedTool, DefinedTools, ToolDefinition, ToolExecutionContext, ToolResult } from '../types/types'
import { objectEntries, objectValues } from '@elmino/shared'
import * as z from 'zod'
import { formatToolArgsIssues } from './format'

/** -------------------- 类型 -------------------- */
/** 批量定义工具时的源定义映射 */
type ToolDefinitions<TSchemas extends Record<string, z.ZodType>> = {
  [K in keyof TSchemas]: ToolDefinition<TSchemas[K]>
}

/** 批量定义后得到的工具映射 */
type DefinedToolMap<TSchemas extends Record<string, z.ZodType>> = {
  [K in keyof TSchemas]: DefinedTool
}

/** -------------------- 核心函数 -------------------- */
/**
 * 使用同一份 Zod Schema 生成工具参数说明，并在执行前校验模型输入
 */
export function defineTool<TSchema extends z.ZodType, TResult extends ToolResult>({
  name,
  description,
  schema,
  hidden,
  approval,
  parallel,
  scope,
  review,
  execute,
}: ToolDefinition<TSchema, TResult> & { name: string }) {
  return {
    declaration: {
      name,
      description,
      schema: z.toJSONSchema(
        schema,
        { io: 'input' },
      ) as unknown as UnknownRecord,
    },
    hidden,
    approval: approval ?? 'never',
    parallel: parallel ?? false,
    scope: typeof scope === 'function'
      ? (args: unknown, context: ToolExecutionContext) => {
          const parsed = schema.safeParse(args)

          if (parsed.success)
            return scope(parsed.data, context)

          const issues = formatToolArgsIssues(parsed.error.issues)

          return {
            scope: 'modify' as const,
            reason: `工具参数无效，无法确认工具作用域: ${issues}`,
          }
        }
      : scope,
    review: review
      ? (args: unknown) => {
          const parsed = schema.safeParse(args)
          return parsed.success ? review(parsed.data) : undefined
        }
      : undefined,
    execute(args: unknown, context: ToolExecutionContext): ToolResult {
      const parsed = schema.safeParse(args)

      if (!parsed.success) {
        const issues = formatToolArgsIssues(parsed.error.issues)

        throw new Error(`工具参数无效: ${issues}`)
      }

      return execute(parsed.data, context)
    },
  }
}

/**
 * 批量定义工具，并自动生成跨 Provider 工具声明
 */
export function defineTools<const TSchemas extends Record<string, z.ZodType>>(
  definitions: ToolDefinitions<TSchemas>,
): DefinedTools<DefinedToolMap<TSchemas>> {
  const entries = objectEntries(definitions)
  const handlers = {} as DefinedToolMap<TSchemas> & Record<string, DefinedTool>

  for (const [name, definition] of entries) {
    handlers[name] = defineTool({
      name,
      ...definition,
    })
  }

  const declarations = objectValues(handlers)
    .map(tool => tool.declaration)

  return {
    declarations,
    handlers,
  }
}
