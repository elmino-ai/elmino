import type { ServerOptions } from '@elmino/server'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { API_DOCS_PATH } from '@elmino/api/paths'
import { defineServer } from '@elmino/server'
import { listen } from '@elmino/server/node'
import { throwSettledErrors } from '@elmino/shared'
import { sqliteStore } from '@elmino/store-sqlite'
import { clock } from '../agent/clock'
import { createModel } from '../model/deepseek'
import { readConfig } from './config'

/** 示例宿主拥有的启动配置，允许测试注入确定性模型 */
interface ExampleServerOptions {
  /** 模型解析与冻结配置恢复 */
  model: ServerOptions['model']
  /** Server 与客户端共享的开发凭据 */
  key: string
  /** 重启复用的独立数据目录 */
  dataDir: string
  /** 默认固定端口，测试可用 0 分配临时端口 */
  port?: number
  /** 默认只允许本机连接 */
  hostname?: string
  /** 允许连接的浏览器来源 */
  corsOrigins?: readonly string[]
}

/** 只启动 Server，由调用方决定何时关闭，不自动执行任务 */
export async function startExampleServer(options: ExampleServerOptions) {
  const workspaceRoot = path.join(options.dataDir, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const server = defineServer({
    agents: { clock },
    workspace: { id: 'example', rootDir: workspaceRoot, store: sqliteStore({ dataDir: options.dataDir }) },
    model: options.model,
    apiKey: options.key,
    corsOrigins: options.corsOrigins,
    onError: error => console.error('服务端执行错误', error),
  })
  let http: Awaited<ReturnType<typeof listen>> | undefined
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      const execution = await Promise.allSettled([server.close()])
      const transport = await Promise.allSettled([http?.close()])
      throwSettledErrors([...execution, ...transport], '关闭远程示例失败', true)
    })
    return closing
  }
  try {
    http = await listen({ server, port: options.port ?? 3000, hostname: options.hostname })
    return { url: http.url, close }
  }
  catch (error) {
    await close()
    throw error
  }
}

/** 常驻服务入口，仅在终止信号到来时结算任务并释放宿主资源 */
export async function runExample() {
  const config = readConfig()
  // 在打开资源前检查模型配置，实际 Turn 再按冻结配置装配适配器
  createModel()
  const stopped = Promise.withResolvers<void>()
  const onSignal = () => stopped.resolve()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let server: Awaited<ReturnType<typeof startExampleServer>> | undefined
  try {
    server = await startExampleServer({
      model: ({ frozenConfig }) => createModel(frozenConfig),
      key: config.key,
      dataDir: config.dataDir,
      port: config.port,
      hostname: config.hostname,
      corsOrigins: config.corsOrigins,
    })
    console.log('Server 地址：', server.url)
    console.log('API 文档：', `${server.url}${API_DOCS_PATH}`)
    console.log('示例数据目录：', config.dataDir)
    console.log('Agent：clock，工作区：example')
    console.log('服务已就绪，在另一个终端运行 pnpm client 发起任务，按 Ctrl+C 关闭')
    await stopped.promise
  }
  finally {
    try {
      await server?.close()
    }
    finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  }
}
