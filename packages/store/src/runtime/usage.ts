/** -------------------- 类型 -------------------- */
/** 从 Step 事实累计的线程或 Turn token 用量 */
export interface ThreadTokenUsage {
  /** 输入 token 数 */
  input: number
  /** 输出 token 数 */
  output: number
  /** 输出中用于推理的 token 数 */
  reasoning: number
  /** 写入 prompt cache 的 token 数 */
  cacheWrite: number
  /** 命中 prompt cache 的 token 数 */
  cacheRead: number
  /** 由本地估算补齐的 token 数 */
  estimated: number
  /** 总 token 数 */
  total: number
  /** prompt cache 命中比例 */
  cacheHitRate: number
}

/** -------------------- 核心函数 -------------------- */
/**
 * 归一化 token 用量并从输入、输出计算派生指标
 */
export function createTokenUsage(
  usage: Partial<ThreadTokenUsage> = {},
): ThreadTokenUsage {
  const input = nonNegativeInteger(usage.input)
  const output = nonNegativeInteger(usage.output)
  const reasoning = Math.min(nonNegativeInteger(usage.reasoning), output)
  const cacheWrite = Math.min(nonNegativeInteger(usage.cacheWrite), input)
  const cacheRead = Math.min(nonNegativeInteger(usage.cacheRead), input)
  const estimated = nonNegativeInteger(usage.estimated)
  const total = input + output

  return {
    input,
    output,
    reasoning,
    cacheWrite,
    cacheRead,
    estimated: Math.min(estimated, total),
    total,
    cacheHitRate: input > 0 ? cacheRead / input : 0,
  }
}

/**
 * 合并两组归一化用量并重新计算总数和缓存命中比例
 */
export function mergeTokenUsage(
  current: Partial<ThreadTokenUsage> | undefined,
  usage: Partial<ThreadTokenUsage>,
) {
  const base = createTokenUsage(current)
  const next = createTokenUsage(usage)

  return createTokenUsage({
    input: base.input + next.input,
    output: base.output + next.output,
    reasoning: base.reasoning + next.reasoning,
    cacheWrite: base.cacheWrite + next.cacheWrite,
    cacheRead: base.cacheRead + next.cacheRead,
    estimated: base.estimated + next.estimated,
  })
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将合法有限正数转成 token 整数，其余值归零
 */
function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}
