import type { ToolCallPart, ToolResultContent } from '@elmino/llm'
import type { RuntimeToolCallStatus as ToolRuntimeStatus } from '@elmino/store'
import type { DefinedTool, ToolExecutionContext } from '@elmino/tool'
import { objectKeys } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 工具执行入参 */
interface HandlerInput {
  /** 实际工具调用 */
  call: ToolCallPart
  /** 当前运行模式唯一的工具处理器表 */
  handlers: Record<string, DefinedTool>
  /** 工具执行上下文 */
  toolContext: ToolExecutionContext
}

/** 工具执行结果 */
interface HandlerResult {
  /** Provider 使用的富内容，纯文本工具直接复用 output */
  content?: ToolResultContent
  /** 错误信息 */
  errorMessage?: string
  /** 工具输出 */
  output: string
  /** 工具运行状态 */
  status: ToolRuntimeStatus
}

/** -------------------- 核心函数 -------------------- */
/**
 * 执行单个工具调用并归一化输出状态
 */
export async function runHandler(
  input: HandlerInput,
): Promise<HandlerResult> {
  const {
    call,
    handlers,
    toolContext,
  } = input
  const handler = handlers[call.name]
  const args = call.args
  let output = ''
  let content: ToolResultContent | undefined
  let status: ToolRuntimeStatus = 'completed'
  let errorMessage: string | undefined

  try {
    if (!handler) {
      status = 'failed'
      const suggestion = suggestTool(
        call.name,
        objectKeys(handlers),
      )

      errorMessage = `模型调用了未声明的工具: ${call.name}${suggestion}`
      output = `错误：${errorMessage}`
    }
    else {
      const result = await handler.execute(args, toolContext)

      if (typeof result === 'string') {
        output = result
      }
      else {
        output = result.output
        content = result.content
        if (result.isError) {
          status = 'failed'
          errorMessage = result.output
        }
      }
    }
  }
  catch (error) {
    if (toolContext.signal?.aborted)
      throw error

    status = 'failed'
    errorMessage = error instanceof Error ? error.message : String(error)
    output = `错误：${errorMessage}`
  }

  return {
    content,
    errorMessage,
    output,
    status,
  }
}

/**
 * 中断信号统一抛出给上层运行恢复逻辑
 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new Error('运行已中断')
}

/** -------------------- 内部函数 -------------------- */
/**
 * 为未声明工具返回纠错名或精简的可用工具列表
 */
function suggestTool(
  name: string,
  availableNames: string[],
) {
  if (availableNames.length === 0)
    return ''

  const candidates = availableNames
    .map(candidate => ({
      name: candidate,
      distance: editDistance(name, candidate),
    }))
    .sort((left, right) => left.distance - right.distance)
  const closest = candidates[0]!
  const maxDistance = Math.max(2, Math.floor(name.length / 3))

  if (closest.distance <= maxDistance)
    return `；可能想调用 ${closest.name}`

  return `；当前可用工具：${availableNames.slice(0, 8).join('、')}`
}

/**
 * 计算两个工具名的最小编辑距离
 */
function editDistance(left: string, right: string) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  )

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex]

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1]
        ? 0
        : 1

      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost,
      )
    }

    previous.splice(0, previous.length, ...current)
  }

  return previous[right.length]!
}
