import type { JsonValue, UnknownRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 可跨输入与持久化消息传递的插件资源引用 */
export interface ThreadMentionReference {
  /** 所属插件稳定 ID */
  pluginId: string
  /** 插件命名空间内的资源稳定 ID */
  resourceId: string
  /** 触发引用的单个字符 */
  trigger: string
  /** 用户可见且用于纯文本降级的标签 */
  label: string
  /** 插件拥有的资源来源与展示快照 */
  data?: JsonValue
}

/** 线程消息片段状态 */
export type ThreadPartStatus = 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
/** 线程消息片段基础字段 */
export interface ThreadPartBase {
  /** 片段 ID */
  id: string
  /** 所属消息 ID */
  messageId: string
  /** 所属线程 ID */
  threadId: string
  /** 所属 Turn ID */
  turnId: string
  /** 消息内稳定顺序 */
  seq: number
  /** 片段状态 */
  status: ThreadPartStatus
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}
/** 文本片段 */
export interface ThreadTextPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'text'
  /** 文本正文 */
  text: string
}
/** Mention 片段 */
export interface ThreadMentionPart extends ThreadMentionReference, ThreadPartBase {
  /** 片段类型 */
  type: 'mention'
}
/** 推理片段 */
export interface ThreadReasoningPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'reasoning'
  /** 推理文本 */
  text: string
  /** Provider 推理元信息 */
  metadata?: UnknownRecord
}
/** 图片片段 */
export interface ThreadImagePart extends ThreadPartBase {
  /** 片段类型 */
  type: 'image'
  /** 图片文件名 */
  name: string
  /** 图片 MIME 类型 */
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  /** 图片可访问地址 */
  url: string
}
/** 文档附件片段 */
export interface ThreadDocumentPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'document'
  /** 文档文件名 */
  name: string
  /** 文档扩展名，支持的解析格式由宿主决定 */
  extension: string
  /** 已持久化文档 Artifact ID */
  artifactId?: string
}
/** 工具片段 */
export interface ThreadToolPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'tool'
  /** RuntimeStore Tool Call ID */
  toolCallId?: string
  /** Provider 原生工具调用 ID */
  providerCallId?: string
  /** 工具名称 */
  toolName: string
  /** 工具调用参数 */
  args?: unknown
  /** 完整工具输出 */
  output?: string
  /** 工具执行错误 */
  error?: string
  /** 工具审批决策 */
  decision?: string
  /** 工具执行耗时 */
  durationMs?: number
  /** 是否在面向用户的消息投影中隐藏 */
  hidden?: boolean
}
/** 插件命名空间消息片段 */
export interface ThreadPluginPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'plugin'
  /** 插件稳定 ID */
  pluginId: string
  /** 插件内局部片段名称 */
  name: string
  /** 插件拥有的 JSON 数据 */
  data: JsonValue
}
/** 普通活动片段 */
export interface ThreadEventPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'event'
  /** 活动标题 */
  title: string
  /** 活动详情 */
  detail?: string
  /** 活动结构化载荷 */
  payload?: unknown
}
/** 错误片段 */
export interface ThreadErrorPart extends ThreadPartBase {
  /** 片段类型 */
  type: 'error'
  /** 错误文本 */
  text: string
}
/** 线程消息片段 */
export type ThreadPart
  = | ThreadDocumentPart
    | ThreadErrorPart
    | ThreadEventPart
    | ThreadImagePart
    | ThreadMentionPart
    | ThreadPluginPart
    | ThreadReasoningPart
    | ThreadTextPart
    | ThreadToolPart
