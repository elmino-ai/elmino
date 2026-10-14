import type { UnknownRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** artifact 存储位置 */
export type RuntimeArtifactStorage = 'inline' | 'blob'

/** artifact 内容类型 */
export type RuntimeArtifactContentKind = 'text' | 'json' | 'bytes'

/** artifact 可用状态 */
export type RuntimeArtifactState = 'available' | 'missing' | 'pending'

/** Artifact 记录 */
export interface RuntimeArtifactRecord {
  /** artifact ID */
  id: string
  /** 所属线程 ID */
  threadId: string
  /** 存储位置 */
  storage: RuntimeArtifactStorage
  /** 内容类型 */
  contentKind: RuntimeArtifactContentKind
  /** 内联文本 */
  inlineText: string | null
  /** 内联 JSON */
  inlineJson: unknown | null
  /** blob key */
  blobKey: string | null
  /** 外部 URI */
  uri: string | null
  /** MIME 类型 */
  mimeType: string | null
  /** 内容编码 */
  encoding: string | null
  /** 内容大小 */
  sizeBytes: number | null
  /** 内容 sha256 */
  sha256: string | null
  /** 预览文本 */
  previewText: string | null
  /** 可用状态 */
  state: RuntimeArtifactState
  /** 缺失时间 */
  missingAt: string | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 扩展元信息 */
  metadata: UnknownRecord
}

/** Artifact 写入参数 */
export interface WriteRuntimeArtifactInput {
  /** artifact ID */
  id?: string
  /** 所属线程 ID */
  threadId: string
  /** 内容类型 */
  contentKind: RuntimeArtifactContentKind
  /** 内联文本 */
  contentText?: string
  /** 内联 JSON */
  contentJson?: unknown
  /** 字节内容 */
  contentBytes?: Uint8Array
  /** 外部 URI */
  uri?: string | null
  /** MIME 类型 */
  mimeType?: string | null
  /** 内容编码 */
  encoding?: string | null
  /** 预览文本 */
  previewText?: string | null
  /** 创建时间 */
  createdAt?: string
  /** 更新时间 */
  updatedAt?: string
  /** 扩展元信息 */
  metadata?: UnknownRecord
}

/** Artifact 文本分页结果 */
export interface RuntimeArtifactTextPage {
  /** 当前页文本 */
  content: string
  /** 实际返回的首行行号，从 1 开始 */
  lineStart: number
  /** 实际返回的末行行号，从 1 开始 */
  lineEnd: number
  /** 全文总行数 */
  totalLines: number
  /** 是否仍有内容未返回 */
  truncated: boolean
}

/** Artifact 文本分页参数 */
export interface ReadRuntimeArtifactTextOptions {
  /** 从零开始的起始虚拟行 */
  offset?: number
  /** 最多返回的虚拟行数 */
  limit?: number
}

/** Artifact 仓储 */
export interface RuntimeArtifactRepository {
  /** 写入 artifact */
  write: (input: WriteRuntimeArtifactInput) => Promise<RuntimeArtifactRecord>
  /** 读取 artifact 并检查 blob 缺失 */
  read: (id: string) => Promise<RuntimeArtifactRecord | undefined>
  /** 分页读取文本或 JSON artifact 正文 */
  readText: (
    id: string,
    options?: ReadRuntimeArtifactTextOptions,
  ) => Promise<RuntimeArtifactTextPage | undefined>
  /** 标记 artifact 缺失 */
  markMissing: (id: string) => Promise<RuntimeArtifactRecord | undefined>
}
