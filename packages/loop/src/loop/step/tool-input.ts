import type { UnknownRecord } from '@elmino/shared'
import { isPlainRecord, jsonParse } from '@elmino/shared'

/** -------------------- 核心函数 -------------------- */
/**
 * 将未闭合的工具参数 JSON 修补为只用于实时展示的对象
 */
export function readPartialToolArgs(input: string): UnknownRecord | undefined {
  const parsed = jsonParse(input)

  if (isPlainRecord(parsed))
    return parsed

  const repaired = repairJson(input)
  const partial = repaired ? jsonParse(repaired) : undefined

  return isPlainRecord(partial) ? partial : undefined
}

/** -------------------- 内部函数 -------------------- */
/**
 * 补齐未闭合字符串与容器，不猜测尚未完成的键、转义或普通值
 */
function repairJson(input: string) {
  const stack: Array<'}' | ']'> = []
  let escapeAt = -1
  let quoted = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (quoted) {
      if (escapeAt >= 0) {
        if (input[escapeAt + 1] !== 'u' || index - escapeAt >= 5)
          escapeAt = -1
        continue
      }
      if (char === '\\')
        escapeAt = index
      else if (char === '"')
        quoted = false
      continue
    }

    if (char === '"') {
      quoted = true
    }
    else if (char === '{') {
      stack.push('}')
    }
    else if (char === '[') {
      stack.push(']')
    }
    else if (char === '}' || char === ']') {
      if (stack.at(-1) !== char)
        return
      stack.pop()
    }
  }

  let value = escapeAt >= 0 ? input.slice(0, escapeAt) : input

  // 未闭合字符串末尾的高代理项要等低代理项到达后再展示，避免产生损坏字符
  if (quoted && /\\u[dD][89aAbB][0-9a-fA-F]{2}$/.test(value))
    value = value.slice(0, -6)
  if (quoted)
    value += '"'

  return value + stack.reverse().join('')
}
