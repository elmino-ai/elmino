import type { RuntimeArtifactRecord, RuntimeArtifactRepository, WriteRuntimeArtifactInput } from '@elmino/store'
import type { DrizzleRuntimeStoreOptions } from '../types/index.js'
import { Buffer } from 'node:buffer'
import { createId } from '@elmino/shared'
import { sha256 } from '@elmino/store/local'
import dayjs from 'dayjs'
import { eq } from 'drizzle-orm'
import { readJson, readJsonObject } from '../codec/index.js'
import * as schema from '../schema/index.js'

/** -------------------- 类型与常量 -------------------- */
/** artifact 内联存储阈值 */
const ARTIFACT_INLINE_THRESHOLD_BYTES = 256 * 1024

/** artifact 文本单页最大 UTF-8 字节数 */
const ARTIFACT_TEXT_MAX_BYTES = 50 * 1024

/** artifact 文本单个虚拟行最大字符数 */
const ARTIFACT_TEXT_MAX_LINE_LENGTH = 2_000

/** artifact 文本单页最大行数 */
const ARTIFACT_TEXT_MAX_LINES = 2_000

/** -------------------- 核心函数 -------------------- */
/**
 * 创建附件内容与缺失状态仓储，不拥有连接或事务生命周期
 */
export function createArtifactRepository({ db, blobStore }: DrizzleRuntimeStoreOptions): RuntimeArtifactRepository {
  /**
   * 标记 artifact 缺失
   */
  const markMissing = async (id: string, missingAt = dayjs().toISOString()) => {
    await db.update(schema.artifacts)
      .set({
        state: 'missing',
        missing_at: missingAt,
        updated_at: missingAt,
      })
      .where(eq(schema.artifacts.id, id))

    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id))

    return row && artifactFromRow(row)
  }

  /**
   * 读取 artifact 并检查 blob 是否缺失
   */
  const read = async (id: string): Promise<RuntimeArtifactRecord | undefined> => {
    // 1. 从当前连接读取记录，事务视图沿用事务自己的可见性
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id))
    const artifact = row && artifactFromRow(row)

    // 2. 外部文件检查可能跨 await，SQLite 层必须将整个操作纳入写队列
    if (!artifact || artifact.storage !== 'blob' || !artifact.blobKey || await blobStore.exists(artifact.blobKey))
      return artifact

    // 3. 缺失状态仍由当前连接写回，关闭必须等待此次操作结算
    return markMissing(id)
  }

  /**
   * 写入 artifact
   */
  const write = async (input: WriteRuntimeArtifactInput) => {
    // 1. 按序列化后的实际大小选择内联或外部文件存储
    const id = input.id ?? createId('artifact')

    const now = input.updatedAt ?? input.createdAt ?? dayjs().toISOString()
    const serialized = serializeArtifactContent(input)
    const storage = serialized.sizeBytes > ARTIFACT_INLINE_THRESHOLD_BYTES || input.contentKind === 'bytes'
      ? 'blob'
      : 'inline'
    // 2. 文件写入完成后再记录引用，避免数据库指向尚未写完的正文
    const blob = storage === 'blob' ? await blobStore.write(serialized.bytes) : undefined

    // 3. 写入元信息，事务失败时引用随数据库事实一起回滚
    const [row] = await db.insert(schema.artifacts).values({
      id,
      thread_id: input.threadId,
      storage,
      content_kind: input.contentKind,
      inline_text: storage === 'inline' && input.contentKind === 'text'
        ? input.contentText ?? null
        : null,
      inline_json: storage === 'inline' && input.contentKind === 'json'
        ? JSON.stringify(input.contentJson ?? null)
        : null,
      blob_key: blob?.blobKey ?? null,
      uri: input.uri ?? null,
      mime_type: input.mimeType ?? null,
      encoding: input.encoding ?? null,
      size_bytes: blob?.sizeBytes ?? serialized.sizeBytes,
      sha256: blob?.sha256 ?? serialized.sha256,
      preview_text: input.previewText ?? serialized.previewText,
      state: 'available',
      missing_at: null,
      created_at: input.createdAt ?? now,
      updated_at: now,
      metadata_json: JSON.stringify(input.metadata ?? {}),
    }).returning()

    // 内容写入已经完成，直接返回持久化事实，避免读侧检查失败把已提交写入误报为失败
    return artifactFromRow(row!)
  }

  return {
    write,
    read,
    /**
     * 分页读取文本或 JSON artifact 正文
     */
    readText: async (id, options = {}) => {
      const artifact = await read(id)

      if (
        !artifact
        || artifact.state !== 'available'
        || artifact.contentKind === 'bytes'
      ) {
        return
      }

      let text: string

      if (artifact.storage === 'blob') {
        if (!artifact.blobKey)
          return

        const stored = Buffer.from(
          await blobStore.read(artifact.blobKey),
        ).toString('utf8')

        text = artifact.contentKind === 'json'
          ? JSON.stringify(JSON.parse(stored), null, 2)
          : stored
      }
      else if (artifact.contentKind === 'json') {
        text = JSON.stringify(artifact.inlineJson ?? null, null, 2)
      }
      else {
        text = artifact.inlineText ?? ''
      }

      // 超长物理行拆成可分页的虚拟行，避免单行工具输出只能看到截断预览
      const lines = text.split(/\r?\n/).flatMap((line) => {
        if (line.length <= ARTIFACT_TEXT_MAX_LINE_LENGTH)
          return line

        return Array.from(
          { length: Math.ceil(line.length / ARTIFACT_TEXT_MAX_LINE_LENGTH) },
          (_, index) => line.slice(
            index * ARTIFACT_TEXT_MAX_LINE_LENGTH,
            (index + 1) * ARTIFACT_TEXT_MAX_LINE_LENGTH,
          ),
        )
      })
      const start = Math.max(0, options.offset ?? 0)
      const maxLines = Math.min(
        options.limit ?? ARTIFACT_TEXT_MAX_LINES,
        ARTIFACT_TEXT_MAX_LINES,
      )
      const selected: string[] = []
      let bytes = 0

      for (
        let index = start;
        index < lines.length && selected.length < maxLines;
        index += 1
      ) {
        const line = lines[index] ?? ''
        const size = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0)

        if (bytes + size > ARTIFACT_TEXT_MAX_BYTES)
          break

        selected.push(line)
        bytes += size
      }

      const lineStart = Math.min(start + 1, lines.length)
      const lineEnd = selected.length > 0 ? start + selected.length : start
      const content = selected.join('\n')
      const truncated = lineEnd < lines.length

      return {
        content,
        lineStart,
        lineEnd,
        totalLines: lines.length,
        truncated,
      }
    },
    markMissing,
  }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 将 artifact 行映射为记录
 */
function artifactFromRow(row: typeof schema.artifacts.$inferSelect): RuntimeArtifactRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    storage: row.storage,
    contentKind: row.content_kind,
    inlineText: row.inline_text,
    inlineJson: readJson(row.inline_json, { nullable: true }),
    blobKey: row.blob_key,
    uri: row.uri,
    mimeType: row.mime_type,
    encoding: row.encoding,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    previewText: row.preview_text,
    state: row.state,
    missingAt: row.missing_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: readJsonObject(row.metadata_json),
  }
}

/**
 * 序列化 artifact 正文
 */
function serializeArtifactContent(input: WriteRuntimeArtifactInput) {
  if (input.contentKind === 'json') {
    const text = JSON.stringify(input.contentJson ?? null)

    return {
      bytes: Buffer.from(text, 'utf8'),
      previewText: input.previewText ?? text.slice(0, 2000),
      sha256: sha256(text),
      sizeBytes: Buffer.byteLength(text),
    }
  }

  if (input.contentKind === 'bytes') {
    const bytes = input.contentBytes ?? new Uint8Array()

    return {
      bytes,
      previewText: input.previewText ?? null,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    }
  }

  const text = input.contentText ?? ''

  return {
    bytes: Buffer.from(text, 'utf8'),
    previewText: input.previewText ?? text.slice(0, 2000),
    sha256: sha256(text),
    sizeBytes: Buffer.byteLength(text),
  }
}
