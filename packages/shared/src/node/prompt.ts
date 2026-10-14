import { readFileSync } from 'node:fs'

/** -------------------- 核心函数 -------------------- */
/**
 * 读取调用方定位的 UTF-8 Prompt 模板并裁剪末尾空白
 */
export function readPromptTemplate(url: URL) {
  return readFileSync(url, 'utf8').trimEnd()
}
