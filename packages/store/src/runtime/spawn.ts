import type { RuntimeThreadRecord } from './thread'
import type { RuntimeTurnRecord } from './turn'

/** -------------------- 类型 -------------------- */
/** 子线程派生关系 */
export interface RuntimeThreadSpawnEdgeRecord {
  /** 创建子线程的能力所有者 */
  ownerId: string
  /** 父线程 ID */
  parentThreadId: string
  /** 子线程 ID */
  childThreadId: string
  /** 派生时间 */
  createdAt: string
}

/** 父线程直接派生的子线程与最新 Turn 投影 */
export interface RuntimeChildTurnRecord {
  /** 创建子线程的能力所有者 */
  ownerId: string
  /** 子线程稳定记录 */
  thread: RuntimeThreadRecord
  /** 子线程最新派生 Turn */
  turn: RuntimeTurnRecord
  /** 发起子线程 Turn 的父工具调用 ID */
  parentToolCallId: string
}

/** 子线程派生关系创建参数 */
export interface CreateRuntimeThreadSpawnEdgeInput {
  /** 创建子线程的能力所有者 */
  ownerId: string
  /** 父线程 ID */
  parentThreadId: string
  /** 子线程 ID */
  childThreadId: string
  /** 派生时间 */
  createdAt?: string
}

/** 子线程 Turn 与父工具调用的派生关系 */
export interface RuntimeTurnSpawnEdgeRecord {
  /** 子线程 Turn ID */
  childTurnId: string
  /** 父工具调用 ID */
  parentToolCallId: string
  /** 派生时间 */
  createdAt: string
}

/** 子线程 Turn 派生关系创建参数 */
export interface CreateRuntimeTurnSpawnEdgeInput {
  /** 子线程 Turn ID */
  childTurnId: string
  /** 父工具调用 ID */
  parentToolCallId: string
  /** 派生时间 */
  createdAt?: string
}

/** 子线程关系仓储 */
export interface RuntimeThreadSpawnEdgeRepository {
  /** 创建父线程与子线程关系 */
  create: (input: CreateRuntimeThreadSpawnEdgeInput) => Promise<RuntimeThreadSpawnEdgeRecord>
  /** 读取子线程关系 */
  readByChild: (childThreadId: string) => Promise<RuntimeThreadSpawnEdgeRecord | undefined>
  /** 列出父线程的直接子线程 */
  listChildren: (parentThreadId: string) => Promise<RuntimeThreadSpawnEdgeRecord[]>
  /** 批量列出父线程直接子线程及其最新派生 Turn */
  listChildrenWithLatestTurn: (parentThreadId: string) => Promise<RuntimeChildTurnRecord[]>
  /** 列出全部子线程关系 */
  list: () => Promise<RuntimeThreadSpawnEdgeRecord[]>
}

/** 子线程 Turn 关系仓储 */
export interface RuntimeTurnSpawnEdgeRepository {
  /** 创建父工具调用与子线程 Turn 关系 */
  create: (input: CreateRuntimeTurnSpawnEdgeInput) => Promise<RuntimeTurnSpawnEdgeRecord>
  /** 按子线程 Turn 读取派生关系 */
  readByChildTurn: (childTurnId: string) => Promise<RuntimeTurnSpawnEdgeRecord | undefined>
  /** 按父工具调用读取派生关系 */
  readByParentToolCall: (parentToolCallId: string) => Promise<RuntimeTurnSpawnEdgeRecord | undefined>
  /** 列出父 Turn 派生的子线程 Turn 关系 */
  listChildren: (parentTurnId: string) => Promise<RuntimeTurnSpawnEdgeRecord[]>
}
