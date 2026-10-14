/** -------------------- 常量 -------------------- */
/** Shell 命令最大超时时间，单位秒 */
export const MAX_SANDBOX_SHELL_TIMEOUT_SECONDS = 600
/** Shell 命令单次等待输出的默认时间，单位秒 */
export const DEFAULT_SANDBOX_SHELL_YIELD_SECONDS = 10
/** Shell 命令单次等待输出的最短时间，单位秒 */
export const MIN_SANDBOX_SHELL_YIELD_SECONDS = 0.25
/** Shell 命令单次等待输出的最长时间，单位秒 */
export const MAX_SANDBOX_SHELL_YIELD_SECONDS = 30
/** 文件操作默认超时时间，单位秒 */
export const DEFAULT_SANDBOX_FILE_TIMEOUT_SECONDS = 60
/** 文件操作最大超时时间，单位秒 */
export const MAX_SANDBOX_FILE_TIMEOUT_SECONDS = 600
/** 单次文本读取默认和最大行数 */
export const SANDBOX_READ_MAX_LINES = 2000
/** 单次文本读取最大 UTF-8 字节数 */
export const SANDBOX_READ_MAX_BYTES = 50 * 1024
/** 单行最大字符数 */
export const SANDBOX_READ_MAX_LINE_LENGTH = 2000
