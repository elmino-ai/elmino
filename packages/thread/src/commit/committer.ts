import type { RuntimeStore, RuntimeThreadRecord } from '@elmino/store'
import type {
  CheckpointInput,
  CompactionInput,
  InitializeInput,
  PartialCommitInput,
  StepCommitInput,
  TurnRef,
} from './types'
import { persistCompaction } from './compaction'
import { checkpointStep, persistPartial, persistStep } from './step'

/** -------------------- 类型 -------------------- */
/** Turn 绑定后的持久提交方法入参 */
type BoundInput<T> = Omit<T, 'turn' | 'threadId' | 'turnId'>

/** -------------------- 核心类 -------------------- */
/**
 * 绑定单个 Turn，统一提交 transcript、Context snapshot 与工具归属
 */
export class ThreadCommitter {
  /**
   * 创建绑定单个 Turn 的持久提交器
   */
  public static create(store: RuntimeStore, turn: TurnRef) {
    return new ThreadCommitter(store, Object.freeze({ ...turn }))
  }

  /**
   * 保存 RuntimeStore 与当前提交范围
   */
  private constructor(
    private readonly _store: RuntimeStore,
    private readonly _ref: TurnRef,
  ) {}

  /** -------------------- 核心方法 -------------------- */
  /**
   * 初始化运行期线程元信息
   */
  public initialize(input: BoundInput<InitializeInput>): Promise<RuntimeThreadRecord> {
    return this._store.threads.upsert({
      id: this._ref.threadId,
      autoTitle: input.autoTitle,
      lastInteractionAt: input.lastInteractionAt,
    })
  }

  /**
   * 建立或更新运行中 Step 的 transcript 内容检查点
   */
  public checkpoint(input: BoundInput<CheckpointInput>) {
    return checkpointStep(this._store, {
      ...input,
      ...this._ref,
    })
  }

  /**
   * 原子提交 Provider Message、下一轮 Context 和工具归属
   */
  public commitStep(
    input: BoundInput<StepCommitInput>,
  ) {
    return persistStep(this._store, {
      ...input,
      ...this._ref,
    })
  }

  /**
   * 提交失败或中断前可安全展示的 partial 文本
   */
  public commitPartial(
    input: BoundInput<PartialCommitInput>,
  ) {
    return persistPartial(this._store, {
      ...input,
      ...this._ref,
    })
  }

  /**
   * 提交上下文压缩提示消息
   */
  public commitCompaction(input?: CompactionInput) {
    return persistCompaction(this._store, this._ref, input)
  }
}
