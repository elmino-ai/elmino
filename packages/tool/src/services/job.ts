import { defineHostService } from './services.js'

/** 宿主提供的辅助模型任务调度能力 */
export interface AuxiliaryQueue {
  /** 按稳定任务 ID 提交可取消任务 */
  submit: <T>(id: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>
}

/** 当前 Agent 的辅助模型任务调度服务 */
export const auxQueueHostService = defineHostService<AuxiliaryQueue>('job.aux')
