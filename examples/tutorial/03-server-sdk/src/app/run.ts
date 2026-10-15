/**
 * Tutorial 03 · 通过 Server 与 SDK 调用 Agent · 从这里开始阅读
 *
 * 本例要讲：区分服务端资源装配、HTTP 接入和客户端提交任务的职责
 * 运行命令：pnpm example:server-sdk
 * 预期结果：Server 常驻等待请求；另一个终端的 SDK 客户端执行任务后退出
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
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
  // 服务端使用稳定数据目录，重启能读回旧记录；不同于每次新建临时目录的 Basic 教程
  const workspaceRoot = path.join(options.dataDir, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  // 第 1 步：定义 Fetch 服务和宿主能力；此时还没有监听端口，也没有向模型提交任务
  const server = defineServer({
    // 客户端按 agentId: clock 选择定义，这个注册键必须与 clock.id 相同
    agents: { clock },
    // 固定工作区接纳 workspaceId: example；存储按需打开，由 Server 生命周期释放
    workspace: { id: 'example', rootDir: workspaceRoot, store: sqliteStore({ dataDir: options.dataDir }) },
    // 宿主在新任务或恢复时装配模型，HTTP 客户端不携带模型 API Key
    model: options.model,
    // 这是客户端访问本 Server 的凭据，与连接 DeepSeek 的 DEEPSEEK_API_KEY 不同
    apiKey: options.key,
    corsOrigins: options.corsOrigins,
    onError: error => console.error('服务端执行错误', error),
  })
  let http: Awaited<ReturnType<typeof listen>> | undefined
  let closing: Promise<void> | undefined
  // 第 2 步：重复关闭复用同一 Promise，Ctrl+C 与错误清理不会争抢资源
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      // 先结算 Agent 执行并释放配置租约；即使失败，也继续关闭网络监听
      const execution = await Promise.allSettled([server.close()])
      const transport = await Promise.allSettled([http?.close()])
      throwSettledErrors([...execution, ...transport], '关闭远程示例失败', true)
    })
    return closing
  }
  try {
    // 第 3 步：到这里才监听端口；listen 管网络，server 管执行，两者分别关闭
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
  // 第 4 步：常驻服务只等待终止信号；SDK 客户端退出不会让 Server 结束
  const stopped = Promise.withResolvers<void>()
  const onSignal = () => stopped.resolve()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let server: Awaited<ReturnType<typeof startExampleServer>> | undefined
  try {
    server = await startExampleServer({
      // 恢复请求带原模型快照；新请求没有快照，工厂才读取当前默认模型
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
      // 第 5 步：收到终止信号后等待清理完成，再撤销信号监听，进程才能正常退出
      await server?.close()
    }
    finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  }
}
