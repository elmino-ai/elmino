/** -------------------- 类型 -------------------- */
/** 本地 token 估算结果 */
interface TokenEstimate {
  /** 截断时对应的字符边界 */
  end: number
  /** 估算 token 数 */
  tokens: number
}

/** -------------------- 核心函数 -------------------- */
/**
 * 扫描本地估算 token 数，并在指定预算处返回字符边界
 */
export function estimateTokens(
  input: string,
  maxTokens = Number.POSITIVE_INFINITY,
): TokenEstimate {
  let tokenQuarters = 0

  if (!Number.isFinite(maxTokens)) {
    // 普通估算不需要逐字符判断预算，整数累计也避免浮点加法
    for (let index = 0; index < input.length; index++)
      tokenQuarters += input.charCodeAt(index) <= 0x7F ? 1 : 4

    return {
      end: input.length,
      tokens: Math.ceil(tokenQuarters / 4),
    }
  }

  const maxTokenQuarters = maxTokens * 4

  for (let index = 0; index < input.length; index++) {
    tokenQuarters += input.charCodeAt(index) <= 0x7F ? 1 : 4

    if (tokenQuarters > maxTokenQuarters) {
      return {
        end: index,
        tokens: Math.ceil(tokenQuarters / 4),
      }
    }
  }

  return {
    end: input.length,
    tokens: Math.ceil(tokenQuarters / 4),
  }
}

/**
 * 按本地估算 token 上限截取文本
 */
export function truncateToEstimatedTokens(input: string, maxTokens: number) {
  return input.slice(0, estimateTokens(input, maxTokens).end)
}
