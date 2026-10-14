import type { Fetch } from '@elmino/shared'

/** -------------------- 类型 -------------------- */
/** 互联网动作审批预检输入 */
export interface SandboxInternetReviewInput {
  /** 互联网动作类型 */
  kind: 'internet'
  /** 网页 URL */
  url?: string
}

/** 沙箱互联网基础能力 */
export interface SandboxInternet {
  /** 发起标准互联网请求 */
  fetch: Fetch
}
