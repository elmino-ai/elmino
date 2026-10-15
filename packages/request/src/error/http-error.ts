import type { UnknownRecord } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 标准 HTTP 错误中的输入问题 */
export interface HttpErrorIssue {
  /** 校验器错误码 */
  code: string
  /** 可读错误信息 */
  message: string
  /** 输入字段路径 */
  path: string
}

/** 构造标准 HTTP 错误的数据 */
export interface HttpErrorInput {
  /** 后端系统稳定标识 */
  system: string
  /** HTTP 状态码 */
  status: number
  /** 可读错误信息 */
  message: string
  /** 稳定业务错误码 */
  code?: string
  /** 业务错误上下文 */
  details?: UnknownRecord
  /** 输入校验问题 */
  issues?: HttpErrorIssue[]
}

/** -------------------- 核心类 -------------------- */
/** 跨后端系统统一暴露的 HTTP 错误 */
export class HttpError extends Error {
  /** 后端系统稳定标识 */
  public readonly system: string

  /** HTTP 状态码 */
  public readonly status: number

  /** 稳定业务错误码 */
  public readonly code?: string

  /** 业务错误上下文 */
  public readonly details?: UnknownRecord

  /** 输入校验问题 */
  public readonly issues?: HttpErrorIssue[]

  /**
   * 创建保留后端来源和业务元数据的 HTTP 异常
   */
  public constructor(input: HttpErrorInput) {
    super(input.message)
    this.name = 'HttpError'
    this.system = input.system
    this.status = input.status
    this.code = input.code
    this.details = input.details
    this.issues = input.issues
  }
}
