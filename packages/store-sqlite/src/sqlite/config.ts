import type { RuntimeStoreProvider } from '@elmino/store'
import path from 'node:path'
import { LocalBlobStore } from '@elmino/store/local'
import { SqliteStore } from './store'

/** SQLite 与本地内容存储的简写配置 */
export interface SqliteStoreConfig {
  /** 运行数据根目录，下含 database 与 blobs，定义配置时解析为绝对路径 */
  dataDir: string
}

/** 只定义配置，首次借用时初始化；同一配置的最后一个调用退出后关闭 SQLite */
export function sqliteStore(config: SqliteStoreConfig): RuntimeStoreProvider {
  const dataDir = path.resolve(config.dataDir)
  const blobStore = LocalBlobStore.create({ rootDir: path.join(dataDir, 'blobs') })
  let opening: Promise<SqliteStore> | undefined
  let closing: Promise<void> | undefined
  let users = 0

  return async () => {
    if (closing)
      await closing
    const pending = opening ??= SqliteStore.create({ dataDir: path.join(dataDir, 'database'), blobStore })
    users++
    let store: SqliteStore
    try {
      store = await pending
    }
    catch (error) {
      users--
      if (opening === pending)
        opening = undefined
      throw error
    }
    let release: Promise<void> | undefined
    return {
      store,
      release: () => release ??= (async () => {
        users--
        if (users > 0)
          return
        const task = store.close()
        closing = task
        try {
          await task
        }
        finally {
          if (opening === pending)
            opening = undefined
          if (closing === task)
            closing = undefined
        }
      })(),
    }
  }
}
