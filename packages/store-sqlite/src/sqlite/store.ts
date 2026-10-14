import type {
  BlobStore,
  RuntimeArtifactRepository,
  RuntimeCanonicalRepository,
  RuntimeStepRepository,
  RuntimeStore,
  RuntimeStoreTx,
  RuntimeThreadRepository,
  RuntimeThreadSpawnEdgeRepository,
  RuntimeToolCallRepository,
  RuntimeTranscriptRepository,
  RuntimeTurnRepository,
  RuntimeTurnSpawnEdgeRepository,
} from '@elmino/store'
import type { RuntimeDrizzleDatabase } from '../drizzle/index.js'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { createDrizzleRuntimeStore, migrateRuntimeStore, runtimeRelations } from '../drizzle/index.js'

/** -------------------- 类型 -------------------- */
/** SQLite RuntimeStore 初始化参数 */
export interface SqliteStoreOptions {
  /** SQLite 本地数据目录 */
  dataDir: string
  /** artifact blob 存储 */
  blobStore: BlobStore
}

/** -------------------- 核心类 -------------------- */
/**
 * 基于 Node.js 内置 SQLite 的本地 RuntimeStore
 */
export class SqliteStore implements RuntimeStore {
  /** 线程仓储 */
  public readonly threads: RuntimeThreadRepository = {
    search: (agentId, query, limit) => this._operation('read', () => this._core.threads.search(agentId, query, limit)),
    upsert: input => this._operation('write', () => this._core.threads.upsert(input)),
    archiveAll: archivedAt => this._operation('write', () => this._core.threads.archiveAll(archivedAt)),
    transitionLifecycle: (id, from, lifecycle) => this._operation(
      'write',
      () => this._core.threads.transitionLifecycle(id, from, lifecycle),
    ),
    read: id => this._operation('read', () => this._core.threads.read(id)),
    listAll: () => this._operation('read', () => this._core.threads.listAll()),
    page: input => this._operation('read', () => this._core.threads.page(input)),
    remove: id => this._operation('write', () => this._core.threads.remove(id)),
  }

  /** UI transcript 仓储 */
  public readonly transcript: RuntimeTranscriptRepository = {
    upsert: message => this._operation('write', () => this._core.transcript.upsert(message)),
    read: id => this._operation('read', () => this._core.transcript.read(id)),
    list: (threadId, turnIds) => this._operation('read', () => this._core.transcript.list(threadId, turnIds)),
  }

  /** Canonical Message/Part 仓储 */
  public readonly canonical: RuntimeCanonicalRepository = {
    append: input => this.transaction(tx => tx.canonical.append(input)),
    appendMany: inputs => this.transaction(tx => tx.canonical.appendMany(inputs)),
    list: (threadId, input) => this._operation('read', () => this._core.canonical.list(threadId, input)),
    listParts: (threadId, input) => this._operation('read', () => this._core.canonical.listParts(threadId, input)),
    readMessage: (threadId, id) => this._operation('read', () => this._core.canonical.readMessage(threadId, id)),
    readPart: (threadId, id) => this._operation('read', () => this._core.canonical.readPart(threadId, id)),
    readParts: (threadId, ids) => this._operation('read', () => this._core.canonical.readParts(threadId, ids)),
    readPartPage: (threadId, id, options) => this._operation(
      'read',
      () => this._core.canonical.readPartPage(threadId, id, options),
    ),
  }

  /** Turn 仓储 */
  public readonly turns: RuntimeTurnRepository = {
    create: input => this._operation('write', () => this._core.turns.create(input)),
    read: id => this._operation('read', () => this._core.turns.read(id)),
    update: (id, input) => this._operation('write', () => this._core.turns.update(id, input)),
    transition: (id, from, input) => this._operation('write', () => this._core.turns.transition(id, from, input)),
    list: threadId => this._operation('read', () => this._core.turns.list(threadId)),
    listAll: () => this._operation('read', () => this._core.turns.listAll()),
    page: input => this._operation('read', () => this._core.turns.page(input)),
    readLatest: threadId => this._operation('read', () => this._core.turns.readLatest(threadId)),
    latest: threadIds => this._operation('read', () => this._core.turns.latest(threadIds)),
    listUsage: () => this._operation('read', () => this._core.turns.listUsage()),
  }

  /** Step 仓储 */
  public readonly steps: RuntimeStepRepository = {
    create: input => this._operation('write', () => this._core.steps.create(input)),
    settle: (id, input) => this._operation('write', () => this._core.steps.settle(id, input)),
    list: turnId => this._operation('read', () => this._core.steps.list(turnId)),
  }

  /** Tool Call 仓储 */
  public readonly toolCalls: RuntimeToolCallRepository = {
    create: input => this._operation('write', () => this._core.toolCalls.create(input)),
    update: (id, input) => this._operation('write', () => this._core.toolCalls.update(id, input)),
    list: input => this._operation('read', () => this._core.toolCalls.list(input)),
  }

  /** 子线程关系仓储 */
  public readonly spawnEdges: RuntimeThreadSpawnEdgeRepository = {
    create: input => this._operation('write', () => this._core.spawnEdges.create(input)),
    readByChild: childThreadId => this._operation('read', () => this._core.spawnEdges.readByChild(childThreadId)),
    listChildren: parentThreadId => this._operation('read', () => this._core.spawnEdges.listChildren(parentThreadId)),
    listChildrenWithLatestTurn: parentThreadId => this._operation(
      'read',
      () => this._core.spawnEdges.listChildrenWithLatestTurn(parentThreadId),
    ),
    list: () => this._operation('read', () => this._core.spawnEdges.list()),
  }

  /** 子线程 Turn 关系仓储 */
  public readonly turnSpawnEdges: RuntimeTurnSpawnEdgeRepository = {
    create: input => this._operation('write', () => this._core.turnSpawnEdges.create(input)),
    readByChildTurn: childTurnId => this._operation(
      'read',
      () => this._core.turnSpawnEdges.readByChildTurn(childTurnId),
    ),
    readByParentToolCall: parentToolCallId => this._operation(
      'read',
      () => this._core.turnSpawnEdges.readByParentToolCall(parentToolCallId),
    ),
    listChildren: parentTurnId => this._operation('read', () => this._core.turnSpawnEdges.listChildren(parentTurnId)),
  }

  /** Artifact 仓储 */
  public readonly artifacts: RuntimeArtifactRepository = {
    write: input => this._operation('write', () => this._core.artifacts.write(input)),
    // 缺失检查会写回状态，必须与事务共用写队列，并纳入关闭等待
    read: id => this._operation('write', () => this._core.artifacts.read(id)),
    readText: (id, options) => this._operation('write', () => this._core.artifacts.readText(id, options)),
    markMissing: id => this._operation('write', () => this._core.artifacts.markMissing(id)),
  }

  /** 普通读取与串行写入使用的长期连接 */
  private readonly _client: DatabaseSync

  /** 异步事务独占的长期连接，普通读取不会看到未提交数据 */
  private readonly _transactionClient: DatabaseSync

  /** 事务连接独享的仓储视图，不拥有连接关闭权 */
  private readonly _transactionCore: RuntimeStoreTx

  /** Drizzle RuntimeStore 核心实现 */
  private readonly _core: RuntimeStoreTx

  /** 文件数据库缓存键 */
  private readonly _cacheKey: string

  /** 当前文件所有者绑定的内容存储，关闭前不得隐式替换 */
  private readonly _blobStore: BlobStore

  /** 同一文件的写入和附件缺失检查串行排序，不阻塞 WAL 普通读取 */
  private _writePending: Promise<void> = Promise.resolve()

  /** 已接纳且尚未结算的读写操作，关闭时等待其全部退出 */
  private readonly _operations = new Set<Promise<unknown>>()

  /** 关闭入口建立后拒绝新读写，已接纳的操作和事务仍可完成 */
  private _closing?: Promise<void>

  /** 文件数据库连接缓存 */
  private static readonly _fileStoreCache = new Map<string, Promise<SqliteStore>>()

  /** -------------------- 核心方法 -------------------- */
  /**
   * 初始化文件 RuntimeStore
   */
  public static async create(options: SqliteStoreOptions): Promise<SqliteStore> {
    const cacheKey = path.resolve(options.dataDir)
    const cached = SqliteStore._fileStoreCache.get(cacheKey)

    if (cached) {
      const store = await cached

      if (store._closing) {
        await store._closing
        return SqliteStore.create(options)
      }

      if (store._blobStore !== options.blobStore)
        throw new Error('同一 SQLite 数据目录已经绑定其他 BlobStore，请先关闭现有存储再重新装配')

      return store
    }

    const store = SqliteStore._createFileStore(options)

    SqliteStore._fileStoreCache.set(cacheKey, store)

    try {
      return await store
    }
    catch (error) {
      if (SqliteStore._fileStoreCache.get(cacheKey) === store)
        SqliteStore._fileStoreCache.delete(cacheKey)

      throw error
    }
  }

  /**
   * 保存 SQLite 连接和仓储依赖
   */
  private constructor(options: {
    client: DatabaseSync
    db: RuntimeDrizzleDatabase
    transactionClient: DatabaseSync
    transactionDb: RuntimeDrizzleDatabase
    blobStore: BlobStore
    cacheKey: string
  }) {
    this._client = options.client
    this._transactionClient = options.transactionClient
    this._cacheKey = options.cacheKey
    this._blobStore = options.blobStore
    this._core = createDrizzleRuntimeStore({
      db: options.db,
      blobStore: options.blobStore,
    })
    this._transactionCore = createDrizzleRuntimeStore({
      db: options.transactionDb,
      blobStore: options.blobStore,
    })
  }

  /**
   * 执行事务并传入同一套仓储接口
   */
  public transaction<T>(fn: (tx: RuntimeStoreTx) => Promise<T>) {
    return this._operation('write', async () => {
      // 内置驱动的 Drizzle transaction 只接受同步回调，这里持有事务直到异步仓储操作结算
      this._transactionClient.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn(this._transactionCore)

        this._transactionClient.exec('COMMIT')
        return result
      }
      catch (error) {
        try {
          this._transactionClient.exec('ROLLBACK')
        }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'SQLite 事务失败且回滚失败')
        }
        throw error
      }
    })
  }

  /**
   * 等待全部已接纳读写结算并幂等关闭两条长期连接
   */
  public close() {
    if (this._closing)
      return this._closing

    this._closing = (async () => {
      await Promise.allSettled(this._operations)

      try {
        this._transactionClient.close()
      }
      finally {
        try {
          this._client.close()
        }
        finally {
          SqliteStore._fileStoreCache.delete(this._cacheKey)
        }
      }
    })()

    return this._closing
  }

  /**
   * 创建文件 RuntimeStore 实例
   */
  private static async _createFileStore(options: SqliteStoreOptions) {
    const dataDir = path.resolve(options.dataDir)

    await mkdir(dataDir, { recursive: true })

    const databasePath = path.join(dataDir, 'store.db')
    const client = new DatabaseSync(databasePath, { timeout: 5000 })
    let transactionClient: DatabaseSync | undefined

    try {
      const drizzleDb = drizzle({ client, relations: runtimeRelations })

      // WAL 允许普通连接读取已提交数据，事务连接跨 await 保持独立的写入视图
      client.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
      migrateRuntimeStore(drizzleDb)
      transactionClient = new DatabaseSync(databasePath, { timeout: 5000 })
      transactionClient.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL')

      return new SqliteStore({
        client,
        db: drizzleDb,
        transactionClient,
        transactionDb: drizzle({ client: transactionClient, relations: runtimeRelations }),
        blobStore: options.blobStore,
        cacheKey: dataDir,
      })
    }
    catch (error) {
      try {
        transactionClient?.close()
      }
      finally {
        client.close()
      }
      throw error
    }
  }

  /**
   * 统一接纳读写并追踪连接使用期，仅写操作参与顺序队列
   */
  private _operation<T>(mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    if (this._closing)
      return Promise.reject(new Error('SQLite 存储已经关闭'))

    const task = mode === 'write'
      ? this._writePending.then(fn)
      : Promise.resolve().then(fn)

    if (mode === 'write')
      this._writePending = task.then(() => undefined, () => undefined)

    this._operations.add(task)
    task.then(
      () => this._operations.delete(task),
      () => this._operations.delete(task),
    )

    return task
  }
}
