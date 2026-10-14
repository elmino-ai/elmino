import type { BlobFiles } from '@elmino/store/local'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 内容存储测试使用真实临时文件，不依赖产品 Sandbox 或用户目录 */
export const testFiles: BlobFiles = {
  exists: async (file) => {
    try {
      await access(file)
      return true
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false
      throw error
    }
  },
  readBytes: file => readFile(file),
  writeBytes: async (file, content) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
    return {}
  },
}
