import type { JsonValue } from '@elmino/shared'
import type { ThreadImagePart, ThreadMentionReference } from '@elmino/store'

/** -------------------- 类型 -------------------- */
/** 用户文本输入块 */
export interface ThreadInputTextContent {
  /** 输入块类型 */
  type: 'text'
  /** 用户输入文本 */
  text: string
}
/** 用户插件 Mention 输入块 */
export interface ThreadInputMentionContent extends ThreadMentionReference {
  /** 输入块类型 */
  type: 'mention'
}
/** 用户图片输入块 */
export interface ThreadInputImageContent {
  /** 输入块类型 */
  type: 'image'
  /** 图片文件名 */
  name: string
  /** 图片 MIME 类型 */
  mime: ThreadImagePart['mime']
  /** 图片 Base64 数据 */
  data: string
  /** 是否允许发送前压缩 */
  compress: boolean
}
/** 用户文档输入块 */
export interface ThreadInputDocumentContent {
  /** 输入块类型 */
  type: 'document'
  /** 文档文件名 */
  name: string
  /** 文档扩展名 */
  extension: string
  /** 文档 Base64 数据 */
  data: string
}
/** 用户结构化输入块 */
export type ThreadInputContent
  = | ThreadInputDocumentContent
    | ThreadInputImageContent
    | ThreadInputMentionContent
    | ThreadInputTextContent
/** 恢复 Turn 参数 */
export interface ResumeTurnInput {
  /** 要恢复的中断 ID */
  interruptId: string
  /** 返回给 Interaction 发起者的 JSON 值 */
  response: JsonValue
}
