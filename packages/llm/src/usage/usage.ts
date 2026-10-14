/** -------------------- 类型 -------------------- */
/** 模型 Provider 统一 token 用量，input/output 均为包含细分项的总数 */
export interface Usage {
  /** 输入 token 总数，包含缓存读写 */
  input: number
  /** 输出 token 总数，包含推理 */
  output: number
  /** 输出中用于推理的 token 数 */
  reasoning: number
  /** 从 Prompt Cache 读取的输入 token 数 */
  cacheRead: number
  /** 写入 Prompt Cache 的输入 token 数 */
  cacheWrite: number
  /** Provider 原始 Usage，用于诊断新字段和兼容服务差异 */
  raw?: Record<string, unknown>
}

/** -------------------- 常量 -------------------- */
/** 空 Usage */
export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/** -------------------- 核心函数 -------------------- */
/**
 * 合并流事件里逐步补齐的累计 Usage
 */
export function mergeUsage(current: Usage, value: Partial<Usage>): Usage {
  return {
    input: value.input ?? current.input,
    output: value.output ?? current.output,
    reasoning: value.reasoning ?? current.reasoning,
    cacheRead: value.cacheRead ?? current.cacheRead,
    cacheWrite: value.cacheWrite ?? current.cacheWrite,
    raw: value.raw ?? current.raw,
  }
}

/**
 * 累加多次独立 Provider sampling 的 Usage
 */
export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}
