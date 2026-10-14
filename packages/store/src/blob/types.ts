/** Blob 内容写入后的定位与完整性信息 */
export interface BlobWriteResult {
  /** 内容寻址键 */
  blobKey: string
  /** 内容 sha256 */
  sha256: string
  /** 内容字节数 */
  sizeBytes: number
}

/** Runtime artifact 内容存储能力 */
export interface BlobStore {
  /** 写入完整内容后返回定位信息，失败时拒绝 */
  write: (content: string | Uint8Array) => Promise<BlobWriteResult>
  /** 仅确认内容不存在时返回 false，存储访问失败时拒绝 */
  exists: (blobKey: string) => Promise<boolean>
  /** 读取原始字节，内容缺失或读取失败时拒绝 */
  read: (blobKey: string) => Promise<Uint8Array>
}
