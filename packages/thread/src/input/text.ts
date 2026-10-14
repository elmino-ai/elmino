import type { ThreadInputContent } from './types'

/** -------------------- 核心函数 -------------------- */
/**
 * 按图片、文档、文本稳定整理线程输入
 */
export function sortThreadInputContent(content: ThreadInputContent[]) {
  const order: Record<ThreadInputContent['type'], number> = {
    image: 0,
    document: 1,
    mention: 2,
    text: 2,
  }

  return content
    .map((part, index) => ({ part, index }))
    .sort((left, right) => (
      order[left.part.type] - order[right.part.type]
      || left.index - right.index
    ))
    .map(item => item.part)
}

/**
 * 读取结构化用户输入中的文本
 */
export function readThreadInputText(content: ThreadInputContent[]) {
  return content
    .filter((part): part is Extract<ThreadInputContent, { type: 'mention' | 'text' }> => (
      part.type === 'mention' || part.type === 'text'
    ))
    .map(part => part.type === 'text' ? part.text : part.label)
    .join('')
}
