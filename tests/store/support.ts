import type { BlobStore } from '@elmino/store'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LocalBlobStore } from '@elmino/store/local'

/** 给独立消费者提供真实文件系统内容存储 */
export function createBlobStore(rootDir: string): BlobStore {
  return LocalBlobStore.create({
    rootDir,
    files: {
      async exists(file: string) {
        try {
          await access(file)
          return true
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return false
          throw error
        }
      },
      async readBytes(file: string) {
        return new Uint8Array(await readFile(file))
      },
      async writeBytes(file: string, bytes: Uint8Array) {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, bytes)
        return {}
      },
    },
  })
}

/** 验证内容落盘、读取与内容寻址复用，并返回数据库消费的同一份字节 */
export async function verifyBlobStore(blobs: BlobStore) {
  const content = new TextEncoder().encode('published artifact content')
  const blob = await blobs.write(content)

  if (!await blobs.exists(blob.blobKey))
    throw new Error('文件内容没有落盘')
  if (new TextDecoder().decode(await blobs.read(blob.blobKey)) !== 'published artifact content')
    throw new Error('文件内容无法回读')
  if ((await blobs.write(content)).blobKey !== blob.blobKey)
    throw new Error('相同内容未复用')
  return content
}
