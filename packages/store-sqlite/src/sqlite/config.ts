import type { RuntimeStoreProvider } from '@elmino/store'
import path from 'node:path'
import { TrimmedStringSchema } from '@elmino/schema'
import { LocalBlobStore } from '@elmino/store/local'
import { createEnv } from '@t3-oss/env-core'
import { SqliteStore } from './store'

/** SQLite 与本地内容存储的简写配置 */
export interface SqliteStoreConfig {
  /** 优先显式目录，其次 ELMINO_DATA_DIR，默认 cwd 下的 .elmino；定义时固定为绝对路径 */
  dataDir?: string
}

/** 只定义配置，首次借用时初始化；同一配置的最后一个调用退出后关闭 SQLite */
export function sqliteStore(config: SqliteStoreConfig = {}): RuntimeStoreProvider {
  const env = createEnv({
    server: { ELMINO_DATA_DIR: TrimmedStringSchema.default('.elmino') },
    runtimeEnv: { ELMINO_DATA_DIR: config.dataDir ?? process.env.ELMINO_DATA_DIR?.trim() },
    emptyStringAsUndefined: true,
  })
  const dataDir = path.resolve(env.ELMINO_DATA_DIR)
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
