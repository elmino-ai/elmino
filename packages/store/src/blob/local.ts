import type { BlobStore, BlobWriteResult } from './types'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { localBlobFiles } from './files'
import { sha256 as hashSha256 } from './hash'

/** Blob 持久化依赖的最小文件能力 */
export interface BlobFiles {
  /** 仅确认文件不存在时返回 false，其他访问错误应拒绝 */
  exists: (filePath: string) => Promise<boolean>
  /** 读取 Blob 二进制内容，缺失或读取失败时拒绝 */
  readBytes: (filePath: string) => Promise<Uint8Array>
  /** 完整写入后返回；原子性、目录创建与实际路径权限由文件实现负责 */
  writeBytes: (filePath: string, content: Uint8Array) => Promise<{ error?: string }>
}

/** 本地 BlobStore 初始化参数 */
export interface BlobOptions {
  /** 可覆盖默认 Node.js 文件能力 */
  files?: BlobFiles
  /** artifact blob 根目录 */
  rootDir: string
}

/** -------------------- 核心类 -------------------- */
/**
 * 通过注入的文件能力保存本地内容寻址 blob
 */
export class LocalBlobStore implements BlobStore {
  /** Blob 持久化所需的最小文件能力 */
  private readonly _files: BlobFiles
  /** artifact blob 根目录 */
  private readonly _rootDir: string

  /**
   * 创建 artifact blob 存储
   */
  public static create(options: BlobOptions) {
    return new LocalBlobStore(options.files ?? localBlobFiles, options.rootDir)
  }

  /**
   * 保存文件能力和 blob 根目录
   */
  private constructor(files: BlobFiles, rootDir: string) {
    this._files = files
    this._rootDir = path.resolve(rootDir)
  }

  /**
   * 写入尚未存在的内容并返回内容寻址 key
   */
  public async write(content: string | Uint8Array): Promise<BlobWriteResult> {
    const buffer = typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content)
    const sha256 = hashSha256(buffer)
    const blobKey = `sha256/${sha256.slice(0, 2)}/${sha256}`
    const targetPath = this._pathForKey(blobKey)

    if (!await this._files.exists(targetPath)) {
      const write = await this._files.writeBytes(targetPath, buffer)

      if (write.error)
        throw new Error(write.error)
    }

    return { blobKey, sha256, sizeBytes: buffer.byteLength }
  }

  /**
   * 判断 blob 是否存在
   */
  public exists(blobKey: string) {
    try {
      return this._files.exists(this._pathForKey(blobKey))
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * 读取 blob 内容
   */
  public read(blobKey: string) {
    try {
      return this._files.readBytes(this._pathForKey(blobKey))
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * 将 blob key 解析为根目录内的本地路径，真实路径权限由文件实现校验
   */
  private _pathForKey(blobKey: string) {
    const resolved = path.resolve(this._rootDir, blobKey)

    if (resolved !== this._rootDir && !resolved.startsWith(`${this._rootDir}${path.sep}`))
      throw new Error(`Blob 键越过根目录: ${blobKey}`)

    return resolved
  }
}
