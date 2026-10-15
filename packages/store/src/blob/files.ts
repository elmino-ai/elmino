import type { BlobFiles } from './local'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Node.js 本地内容存储的默认文件能力，权限边界仍由数据目录的创建方决定 */
export const localBlobFiles: BlobFiles = {
  async exists(file) {
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
  async writeBytes(file, content) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
    return {}
  },
}
