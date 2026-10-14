/** -------------------- 常量 -------------------- */
/** 默认输出 token 上限 */
export const DEFAULT_MAX_TOKENS = 12_000

/** 截断后升级的输出 token 上限 */
export const ESCALATED_MAX_TOKENS = 20_000

/** max_tokens 截断后的续写次数上限 */
export const MAX_CONTINUATION_RETRIES = 3

/** 空可见回复恢复次数上限 */
export const MAX_EMPTY_RESPONSE_RETRIES = 1

/** 瞬态错误最大重试次数 */
export const MAX_TRANSIENT_RETRIES = 10

/** 指数退避基础延迟 */
export const BASE_DELAY_MS = 500

/** 指数退避最大延迟 */
export const MAX_DELAY_MS = 32_000

/** 上下文长度错误识别正则 */
export const PROMPT_TOO_LONG_PATTERN
  = /prompt_too_long|prompt_is_too_long|context_length_exceeded|max_context_window|too many tokens|413/
