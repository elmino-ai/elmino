/**
 * 第 1 步：定义应用，集中注册 Agent、模型与工作区
 *
 * defineElmino 只捕获配置；首次运行才创建 Engine 并借用存储
 * 此实例可以本地运行，也能在下一篇教程中交给 defineServer
 */
import type { ElminoOptions } from '@elmino/core'
import { fileURLToPath } from 'node:url'
import { defineElmino } from '@elmino/core'
import { sqliteStore } from '@elmino/store-sqlite'
import { clock } from '../agent/clock'
import { createModel } from '../model/deepseek'

/** 默认使用真实模型工厂；测试可传入确定性模型而无需真实凭据 */
export function createExampleElmino(models: ElminoOptions['models'] = {
  // deepseek 是稳定注册键；冻结快照用于按原配置恢复，密钥只在工厂内读取
  deepseek: ({ frozenConfig }) => createModel(frozenConfig),
}) {
  const rootDir = fileURLToPath(new URL('../..', import.meta.url))
  return defineElmino({
    agents: { clock },
    // 只有一个模型时自动选用它；多个模型时再指定 defaults.model 或单轮 modelId
    models,
    // 固定工作区让 run 可以省略 workspaceId；目录与模型无需每次调用都重新传入
    workspace: { id: 'example', rootDir, store: sqliteStore() },
    onError: error => console.error('Agent 执行错误', error),
  })
}
