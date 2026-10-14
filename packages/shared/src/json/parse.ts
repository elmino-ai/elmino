/** -------------------- 核心函数 -------------------- */
/**
 * 安全解析 JSON 字符串
 */
export function jsonParse(input: unknown): unknown | undefined
export function jsonParse<T>(input: unknown, defaultValue: T): T
export function jsonParse<T>(
  input: unknown,
  defaultValue?: T,
): unknown | T | undefined {
  if (typeof input !== 'string')
    return input ?? defaultValue

  try {
    const result = JSON.parse(input)

    return result ?? defaultValue
  }
  catch {
    return defaultValue
  }
}
