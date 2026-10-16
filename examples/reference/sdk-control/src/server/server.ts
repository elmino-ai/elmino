import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineElmino } from '@elmino/core'
import { defineServer } from '@elmino/server'
import { sqliteStore } from '@elmino/store-sqlite'
import { createAssistant } from '../agent/agent'
import { createModel } from '../model/model'

/**
 * 本机临时服务只属于本示例；不连接已有 Tutorial Server，也不读取其凭据
 */
export async function createExampleServer() {
  // 每次运行使用独立临时目录，保留数据便于演示后检查结果
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-sdk-control-'))
  // Agent 定义交给 Elmino，门控仍由示例宿主操作
  const { agent, gates } = createAssistant()
  // 应用实例持有模型、执行引擎和 SQLite 租约，关闭时由创建方释放
  const elmino = defineElmino({
    agents: { assistant: agent },
    models: { teaching: createModel() },
    workspace: { id: 'example', rootDir: dataDir, store: sqliteStore({ dataDir }) },
    defaults: { approvalMode: 'request' },
  })
  // 仅监听本机的独立教学服务不读取其他示例凭据，也不接受浏览器跨域调用
  const server = defineServer({ elmino, apiKey: null, corsOrigins: [] })
  return { server, gates, dataDir }
}
