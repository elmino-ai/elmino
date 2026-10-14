import type { ShellCommandAssessment } from '../policy/types'

/** -------------------- 工具函数 -------------------- */
/**
 * 创建危险语法或已知副作用的命令事实
 */
export function dangerous(reason: string): ShellCommandAssessment {
  return { category: 'dangerous', reason }
}

/**
 * 创建无法可靠解析的命令事实
 */
export function unknown(reason: string): ShellCommandAssessment {
  return { category: 'unknown', reason }
}

/**
 * 按简单 shell 分隔符切分命令段
 */
export function splitCommandSegments(source: string, operators: string[]) {
  const sortedOperators = [...operators].sort((left, right) => right.length - left.length)
  const segments: string[] = []
  let quote = ''
  let current = ''

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!

    if (quote) {
      if (char === quote)
        quote = ''
      current += char
      continue
    }

    if (char === '\'' || char === '"') {
      quote = char
      current += char
      continue
    }

    const operator = sortedOperators.find(operator => source.startsWith(operator, index))

    if (operator) {
      segments.push(current.trim())
      current = ''
      index += operator.length - 1
      continue
    }

    current += char
  }

  if (quote)
    return

  segments.push(current.trim())

  return segments.every(segment => segment.length > 0)
    ? segments
    : undefined
}

/**
 * 按空白切分简单 shell 参数并保留引号内文本
 */
export function splitShellWords(source: string) {
  const words: string[] = []
  let quote = ''
  let current = ''

  for (const char of source) {
    if (quote) {
      if (char === quote) {
        quote = ''
        continue
      }

      current += char
      continue
    }

    if (char === '\'' || char === '"') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (quote)
    return

  if (current)
    words.push(current)

  return words
}
