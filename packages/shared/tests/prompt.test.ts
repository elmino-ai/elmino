import { createPromptTemplate } from '@elmino/shared'
import { readPromptTemplate } from '@elmino/shared/node'
import { describe, expect, test } from 'vitest'

describe('Prompt 模板', () => {
  test('保留模板信息并替换字符串和数字变量', () => {
    const template = createPromptTemplate<{
      name: string
      count: number
    }>({
      template: 'Hello {{name}}, count={{count}}, again={{name}}',
      inputVariables: ['name', 'count'],
    })

    expect(template.template).toBe('Hello {{name}}, count={{count}}, again={{name}}')
    expect(template.inputVariables).toEqual(['name', 'count'])
    expect(template.format({ name: 'Elmino', count: 2 }))
      .toBe('Hello Elmino, count=2, again=Elmino')
  })

  test('按调用方 URL 读取模板并裁剪末尾空白', () => {
    const template = readPromptTemplate(new URL('./fixtures/prompt.md', import.meta.url))

    expect(template).toBe('Hello {{name}}\nCount: {{count}}')
  })
})
