/** -------------------- Canonical Message 类型 -------------------- */
/** 跨 Provider 统一的消息角色 */
export type Role = 'assistant' | 'system' | 'tool' | 'user'

/** 标准化结束原因 */
export type FinishReason
  = | 'completed'
    | 'error'
    | 'filtered'
    | 'interrupted'
    | 'other'
    | 'paused'
    | 'tool-calls'
    | 'truncated'

/** 文本片段 */
export interface TextPart {
  /** 片段类型 */
  type: 'text'
  /** 文本正文 */
  text: string
}

/** 推理片段 */
export interface ReasoningPart {
  /** 片段类型 */
  type: 'reasoning'
  /** 推理正文 */
  text: string
  /** Provider 恢复多轮推理所需的签名或加密内容 */
  signature?: string
  /** Provider 原始推理元信息 */
  metadata?: Record<string, unknown>
  /** 只保留在 Provider 上下文中，不投影到 Runtime transcript */
  visibility?: 'context-only'
}

/** 图片片段 */
export interface ImagePart {
  /** 片段类型 */
  type: 'image'
  /** 图片 MIME 类型 */
  mime: string
  /** Base64、data URL 或远程 URL */
  data: string
  /** 图片文件名 */
  name?: string
}

/** 文档片段 */
export interface DocumentPart {
  /** 片段类型 */
  type: 'document'
  /** 文档 MIME 类型 */
  mime: string
  /** Base64、data URL 或远程 URL */
  data: string
  /** 文档文件名 */
  name?: string
}

/** 工具调用片段 */
export interface ToolCallPart {
  /** 片段类型 */
  type: 'tool-call'
  /** Provider 原生工具调用 ID */
  id: string
  /** 工具名称 */
  name: string
  /** 已解析的工具参数 */
  args: Record<string, unknown>
  /** 最终参数草稿是否无法解析为 JSON 对象 */
  invalidArgs?: true
  /** 流式阶段尚未完整解析的 JSON 草稿 */
  argsText?: string
  /** Provider 原始工具调用元信息 */
  metadata?: Record<string, unknown>
}

/** 工具结果片段 */
export interface ToolResultPart {
  /** 片段类型 */
  type: 'tool-result'
  /** 对应的 Provider 工具调用 ID */
  callId: string
  /** 工具名称 */
  name?: string
  /** 工具输出内容 */
  result: string | Array<DocumentPart | ImagePart | TextPart>
  /** 本地 transcript 使用的文本投影，不参与 Provider 映射 */
  output?: string
  /** 工具是否执行失败 */
  error?: boolean
}

/** 本地工具返回给 Provider 的统一内容 */
export type ToolResultContent = ToolResultPart['result']

/** 跨 Provider 统一的消息片段 */
export type Part
  = | DocumentPart
    | ImagePart
    | ReasoningPart
    | TextPart
    | ToolCallPart
    | ToolResultPart

/** 跨 Provider 统一的消息；它是一次完成 sampling 的唯一可回放事实 */
export interface Message {
  /** 消息角色 */
  role: Role
  /** Provider 原始顺序下的完整消息片段 */
  parts: Part[]
  /** Provider 原生响应 ID */
  id?: string
  /** 标准化停止原因，仅 assistant 响应存在 */
  finishReason?: FinishReason
  /** Provider 原始停止原因 */
  rawFinishReason?: string | null
  /** Provider 原始消息元信息 */
  metadata?: Record<string, unknown>
}
