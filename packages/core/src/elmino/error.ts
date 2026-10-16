/** 应用错误由接入层映射成具体传输协议 */
export type ElminoErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE'

/** 本地调用可按 code 判断失败，核心不依赖 HTTP 或 oRPC */
export class ElminoError extends Error {
  /** 创建稳定的应用错误，保留底层失败原因 */
  public constructor(public readonly code: ElminoErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ElminoError'
  }
}
