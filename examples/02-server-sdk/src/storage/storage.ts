import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'

/** 宿主显式装配 SQLite 与文件内容存储 */
export function createStorage(dataDir: string) {
  const blobStore = LocalBlobStore.create({
    rootDir: path.join(dataDir, 'blobs'),
    files: {
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
    },
  })
  return SqliteStore.create({ dataDir: path.join(dataDir, 'database'), blobStore })
}
