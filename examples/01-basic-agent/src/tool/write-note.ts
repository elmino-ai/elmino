import { defineTools } from '@elmino/tool'
import * as z from 'zod'

/** 示例只提供写入当前工作区 result.txt 的工具 */
export const tools = defineTools({
  write_note: {
    description: '将文字写入当前工作区的 result.txt',
    schema: z.object({ text: z.string().min(1) }),
    scope: 'modify',
    async execute({ text }, { sandbox }) {
      const result = await sandbox.files.write('result.txt', text)
      if (result.error)
        throw new Error(result.error)
      return `已写入 ${result.path}`
    },
  },
})
