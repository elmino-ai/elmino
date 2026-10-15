import type { Agent } from '@elmino/agent'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { Runtime, RuntimeCreateContext } from '@elmino/runtime'
import type { Promisable, UnknownRecord } from '@elmino/shared'
import type { SubagentRole } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
/** -------------------- 类型 -------------------- */
/** 宿主创建线程 Runtime 所需的位置上下文 */
export type RuntimeFactoryContext = Pick<RuntimeCreateContext, 'location'>

/** 宿主注入的 Runtime 创建边界 */
export type RuntimeFactory = (
  agent: Agent,
  context: RuntimeFactoryContext,
) => Runtime

/** 单次 Turn 持有的 Workspace 访问凭证 */
export interface WorkspaceAccessPermit {
  /** 释放当前 Turn 的项目占用 */
  release: () => void
}

/** 宿主提供的 Workspace 访问凭证入口 */
export type WorkspaceAccessAcquirer = (
  agentId: string,
  workspaceId: string,
) => WorkspaceAccessPermit

/** AgentEngine 的宿主依赖 */
export interface AgentEngineOptions {
  /** 同步或异步加载新 Turn 的角色目录，恢复时沿用已冻结的角色 */
  subagentRoles?: () => Promisable<SubagentRole[]>
  /** 校验持久化冻结配置并恢复可调用模型 */
  restoreModel?: (config: UnknownRecord) => Promisable<TurnModel<ModelTurnConfig>>
  /** 使用宿主路径策略创建项目 Runtime */
  createRuntime?: RuntimeFactory
  /** 在 Turn 全生命周期内阻止项目被删除 */
  acquireWorkspace?: WorkspaceAccessAcquirer
  /** 没有请求调用方时使用的全局事件出口 */
  onRuntimeEvent?: (agentId: string, event: RuntimeEvent) => Promisable<void>
}
