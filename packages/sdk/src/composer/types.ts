import type { ThreadInputContent } from '@elmino/thread'
import type { ClientRun, ClientThreadRunOptions } from '../run/types'
import type { ClientThread } from '../thread/types'

/** 可直接编辑的文本或已由宿主准备好的结构化输入 */
export type ComposerInput = string | readonly ThreadInputContent[]

/** 提交时冻结的运行策略，不持有观察回调或取消信号 */
export type ComposerRunOptions = Pick<ClientThreadRunOptions, 'modelId' | 'approvalMode' | 'subagentMode'>

/** 固定会话内等待后续发送的输入 */
export interface ComposerQueuedInput {
  /** 当前队列项的稳定身份 */
  readonly id: string
  /** 排队时冻结的正文与附件 */
  readonly input: readonly ThreadInputContent[]
  /** 排队时冻结的运行策略 */
  readonly options: ComposerRunOptions
  /** 已尝试提交或前一轮异常结束，编辑重提后才再次发送 */
  readonly paused: boolean
}

/** 只持有当前会话草稿与本地发送队列的装配参数 */
export interface ComposerOptions {
  /** 唯一会话状态所有者，创建后不能切换 */
  thread: ClientThread
  /** 可选初始草稿，不从设备存储自动恢复 */
  input?: ComposerInput
}

/** Composer 发布的引用稳定快照，不复制会话消息与运行状态 */
export interface ComposerSnapshot {
  /** 当前尚未接纳的草稿 */
  readonly input: readonly ThreadInputContent[]
  /** 当前会话等待发送的队列 */
  readonly queue: readonly ComposerQueuedInput[]
  /** 正在等待一次发送的服务端接纳 */
  readonly submitting: boolean
  /** 当前草稿是否允许提交，运行中提交会进入队列 */
  readonly canSubmit: boolean
  /** 最近一次发送、队列或本地观察失败的原因 */
  readonly error?: unknown
}

/** 提交前可由调用方直接展示的阻断原因 */
export type ComposerSubmitBlockedReason = 'empty' | 'submitting' | 'pendingInteraction' | 'closed'

/** 提交只等待接纳，完整执行与控制继续由原运行句柄提供 */
export type ComposerSubmitResult
  = | {
    /** 当前输入未发出 */
    status: 'blocked'
    /** 阻止本次发送的原因 */
    reason: ComposerSubmitBlockedReason
  }
  | {
    /** 当前运行结束后再尝试发送 */
    status: 'queued'
    /** 固定绑定当前会话的队列项 */
    item: ComposerQueuedInput
  }
  | {
    /** 服务端已经接纳本次输入 */
    status: 'submitted'
    /** 原运行的接纳、完成与控制能力 */
    run: ClientRun
  }
