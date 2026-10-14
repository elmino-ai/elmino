import type { UnknownRecord } from '@elmino/shared'
import type { ApprovalMode } from '../runtime/state'
import type { SubagentMode } from '../runtime/subagent'

/** -------------------- 类型 -------------------- */
/** 按插件稳定 ID 隔离的线程级设置 */
export interface ThreadPluginSettings {
  /** 单个插件拥有的设置对象 */
  [pluginId: string]: UnknownRecord
}

/** 持久化线程设置，修改后作用于后续 Turn */
export interface ThreadSettings {
  /** 宿主提供的模型配置 ID，存储不解析模型目录或凭据 */
  modelId?: string
  /** 宿主或模型声明的推理强度名称 */
  reasoningLevel?: string
  /** 后续 Turn 使用的人机交互访问级别 */
  approvalMode: ApprovalMode
  /** 后续 Turn 使用的子智能体调度模式 */
  subagentMode: SubagentMode
  /** 插件拥有并按稳定 ID 隔离的线程设置 */
  pluginSettings: ThreadPluginSettings
}

/** -------------------- 常量 -------------------- */
/** 未选择模型时的线程设置，保留现有执行默认值 */
export const DEFAULT_THREAD_SETTINGS: Readonly<ThreadSettings> = {
  approvalMode: 'fullAccess',
  subagentMode: 'explicitOnly',
  pluginSettings: {},
}
