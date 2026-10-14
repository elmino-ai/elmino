import type { TextPart } from '@elmino/llm'
import type { PromptContextSection } from '../../hooks/index'

/** -------------------- 下一请求 Context 投影 -------------------- */
/**
 * 装配系统提示词，并自动注入 loop 运行时环境
 */
export function createSystemPrompt(
  baseSystem: TextPart[],
  contextSections: PromptContextSection[],
) {
  const baseText = baseSystem
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n\n')

  const text = [
    baseText,
    ...contextSections
      .filter(section => section.content.trim())
      .map(section => section.format === 'raw'
        ? section.content.trim()
        : renderSection(section)),
  ].filter(Boolean).join('\n\n')

  return [{ type: 'text' as const, text }]
}

/** -------------------- 内部函数 -------------------- */
/**
 * 渲染带语义标签的 Prompt 上下文片段
 */
function renderSection(section: PromptContextSection) {
  const openTag = `<${section.tag}>`
  const closeTag = `</${section.tag}>`
  // 内容中的同名边界只做展示转义，不能提前闭合运行时生成的上下文片段
  const content = section.content
    .trim()
    .replaceAll(openTag, `&lt;${section.tag}&gt;`)
    .replaceAll(closeTag, `&lt;/${section.tag}&gt;`)

  return [openTag, content, closeTag].join('\n')
}
