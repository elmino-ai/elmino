import type { UnknownRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** Canonical Message 角色 */
export type RuntimeCanonicalRole = 'assistant' | 'system' | 'tool' | 'user'

/** Canonical Part 类型 */
export type RuntimeCanonicalPartType
  = | 'document'
    | 'image'
    | 'reasoning'
    | 'text'
    | 'tool-call'
    | 'tool-result'

/** Canonical Message 的不可变元数据 */
export interface RuntimeCanonicalMessageRecord {
  /** 本地稳定消息 ID */
  id: string
  /** 所属线程 ID */
  threadId: string
  /** 首次写入该消息的 Turn ID */
  turnId: string
  /** 线程内不可变顺序 */
  seq: number
  /** 消息角色 */
  role: RuntimeCanonicalRole
  /** Provider 原始消息 ID */
  providerId: string | null
  /** 标准化结束原因 */
  finishReason: string | null
  /** Provider 原始结束原因 */
  rawFinishReason: string | null
  /** Provider 原始消息元信息 */
  metadata: UnknownRecord
  /** 首次写入时间 */
  createdAt: string
}

/** Canonical Part 的不可变元数据 */
export interface RuntimeCanonicalPartMetadataRecord {
  /** 本地稳定 Part ID */
  id: string
  /** 所属 Canonical Message ID */
  messageId: string
  /** 消息内不可变顺序 */
  seq: number
  /** Part 类型 */
  type: RuntimeCanonicalPartType
  /** 完整 JSON 的 UTF-8 字节数 */
  sizeBytes: number
  /** 首次写入时间 */
  createdAt: string
}

/** 包含完整原始 JSON 的 Canonical Part */
export interface RuntimeCanonicalPartRecord extends RuntimeCanonicalPartMetadataRecord {
  /** 从 BLOB 无损解析的 Part JSON */
  content: UnknownRecord
}

/** 包含完整 Parts 的 Canonical Message */
export interface RuntimeCanonicalMessageWithParts extends RuntimeCanonicalMessageRecord {
  /** Provider 原始顺序下的完整 Parts */
  parts: RuntimeCanonicalPartRecord[]
}

/** 追加单条 Canonical Message 的输入 */
export interface AppendRuntimeCanonicalMessageInput {
  /** 本地稳定消息 ID */
  id?: string
  /** 所属线程 ID */
  threadId: string
  /** 首次写入该消息的 Turn ID */
  turnId: string
  /** 线程内顺序，缺省时在事务内追加 */
  seq?: number
  /** 消息角色 */
  role: RuntimeCanonicalRole
  /** Provider 原始消息 ID */
  providerId?: string | null
  /** 标准化结束原因 */
  finishReason?: string | null
  /** Provider 原始结束原因 */
  rawFinishReason?: string | null
  /** Provider 原始消息元信息 */
  metadata?: UnknownRecord
  /** Provider 原始顺序下的完整 Parts */
  parts: Array<{
    /** 本地稳定 Part ID */
    id?: string
    /** Part 类型 */
    type: RuntimeCanonicalPartType
    /** 无损 Part JSON */
    content: UnknownRecord
  }>
  /** 首次写入时间 */
  createdAt?: string
}

/** Canonical Message 范围读取参数 */
export interface RuntimeCanonicalRangeInput {
  /** 只读取该 seq 之后的消息 */
  afterSeq?: number
  /** 只读取该 seq 及之前的消息 */
  throughSeq?: number
}

/** Canonical BLOB 文本分页参数 */
export interface ReadRuntimeCanonicalPartPageOptions {
  /** UTF-8 文本字符偏移 */
  offset?: number
  /** 单页最大字符数 */
  limit?: number
}

/** Canonical BLOB 文本分页结果 */
export interface RuntimeCanonicalPartPage {
  /** Canonical Part ID */
  id: string
  /** 所属 Canonical Message ID */
  messageId: string
  /** Part 类型 */
  type: RuntimeCanonicalPartType
  /** 当前页字符偏移 */
  offset: number
  /** 当前页 JSON 文本 */
  content: string
  /** 下一页字符偏移 */
  nextOffset?: number
  /** 完整 JSON 字符数 */
  totalLength: number
  /** 完整 JSON UTF-8 字节数 */
  sizeBytes: number
}

/** Canonical Message/Part 仓储 */
export interface RuntimeCanonicalRepository {
  /** 原子追加单条完整 Canonical Message */
  append: (input: AppendRuntimeCanonicalMessageInput) => Promise<RuntimeCanonicalMessageWithParts>
  /** 按输入顺序原子追加完整 Canonical Messages */
  appendMany: (inputs: AppendRuntimeCanonicalMessageInput[]) => Promise<RuntimeCanonicalMessageWithParts[]>
  /** 按线程顺序读取 Canonical Message 元数据 */
  list: (threadId: string, input?: RuntimeCanonicalRangeInput) => Promise<RuntimeCanonicalMessageRecord[]>
  /** 按线程顺序读取 Canonical Part 元数据，不加载 BLOB */
  listParts: (threadId: string, input?: RuntimeCanonicalRangeInput) => Promise<RuntimeCanonicalPartMetadataRecord[]>
  /** 读取单条完整 Canonical Message */
  readMessage: (threadId: string, id: string) => Promise<RuntimeCanonicalMessageWithParts | undefined>
  /** 读取单条完整 Canonical Part */
  readPart: (threadId: string, id: string) => Promise<RuntimeCanonicalPartRecord | undefined>
  /** 批量读取当前线程拥有的 Canonical Part */
  readParts: (threadId: string, ids: string[]) => Promise<RuntimeCanonicalPartRecord[]>
  /** 直接在 SQLite 中分页读取单条 Canonical Part BLOB */
  readPartPage: (
    threadId: string,
    id: string,
    options?: ReadRuntimeCanonicalPartPageOptions,
  ) => Promise<RuntimeCanonicalPartPage | undefined>
}
