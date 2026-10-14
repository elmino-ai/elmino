/** -------------------- 类型 -------------------- */
/** 按稳定前缀读取的仓储分页结果 */
export interface PaginationResult<TItem> {
  /** 当前稳定前缀数据 */
  items: TItem[]
  /** 是否仍有未加载数据 */
  hasMore: boolean
}
