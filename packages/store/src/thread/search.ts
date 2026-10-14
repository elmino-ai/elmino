/** -------------------- 类型 -------------------- */
/** 单个线程的关键词命中，不提供宿主展示文案 */
export interface ThreadSearchHit {
  /** 命中的线程 ID */
  threadId: string
  /** 已有标题；缺省展示文案由宿主决定 */
  title?: string
  /** 标题或正文中的命中片段 */
  snippet: string
  /** 最近互动时间 */
  lastInteractionAt: string
}

/** 线程列表当前过滤范围的仓储统计 */
export interface ThreadListSummary {
  /** 线程总数 */
  total: number
  /** 存在未读根 Turn 的线程数 */
  unread: number
}
