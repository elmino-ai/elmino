import { readPromptTemplate } from '@elmino/shared/node'

/** -------------------- 常量 -------------------- */
/** 通用子智能体的内置角色资产 */
export const DEFAULT_SUBAGENT_ROLE_MARKDOWN = readPromptTemplate(
  new URL('../template/subagent/default.md', import.meta.url),
)

/** 只读代码与资料探索者的内置角色资产 */
export const EXPLORER_SUBAGENT_ROLE_MARKDOWN = readPromptTemplate(
  new URL('../template/subagent/explorer.md', import.meta.url),
)

/** 独立生产性任务执行者的内置角色资产 */
export const WORKER_SUBAGENT_ROLE_MARKDOWN = readPromptTemplate(
  new URL('../template/subagent/worker.md', import.meta.url),
)
