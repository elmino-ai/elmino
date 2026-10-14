/** -------------------- 类型 -------------------- */
/** 人机交互访问级别，由宿主审批策略解释 */
export type ApprovalMode = 'request' | 'auto' | 'fullAccess'

/** 线程稳定运行状态，尚未提交 Turn 时为 idle */
export type ThreadStatus = 'idle' | 'running' | 'interrupted' | 'completed' | 'failed'

/** 单次 Turn 生命周期状态，独立保存排队与取消事实 */
export type ThreadTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
