import type { ThreadImagePart } from '@elmino/store'
import type { ThreadInputMentionContent } from '@elmino/thread'
/** -------------------- 类型 -------------------- */
/** 已完成宿主预处理的文本输入 */
export interface TurnInputTextPart {
  /** 输入类型 */
  type: 'text'
  /** 用户可见文本 */
  text: string
}
/** 已完成宿主校验的引用输入 */
export type TurnInputMentionPart = ThreadInputMentionContent
/** 已完成宿主预处理的图片输入 */
export interface TurnInputImagePart {
  /** 输入类型 */
  type: 'image'
  /** 原始图片名称 */
  name: string
  /** Provider 可接收的图片 MIME 类型 */
  mime: ThreadImagePart['mime']
  /** 不含 Data URL 前缀的图片 Base64 */
  data: string
}
/** 已完成宿主解析的文档输入 */
export interface TurnInputDocumentPart {
  /** 输入类型 */
  type: 'document'
  /** 原始文档名称 */
  name: string
  /** 原始文档扩展名 */
  extension: string
  /** 解析后全文的 artifact 引用 */
  artifactId: string
  /** 仅注入模型上下文的首段文本和续读提示 */
  modelText: string
}
/** AgentEngine 接收的结构化用户输入 */
export type TurnInputPart
  = | TurnInputDocumentPart
    | TurnInputImagePart
    | TurnInputMentionPart
    | TurnInputTextPart
