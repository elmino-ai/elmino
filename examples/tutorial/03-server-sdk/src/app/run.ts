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
  /** 允许连接的浏览器来源 */
  corsOrigins?: readonly string[]
}

/** 准备本地工作区并定义 Server；模型注入也让测试无需访问真实服务 */
export async function createExampleServer(options: ExampleServerOptions) {
  // 服务端使用稳定数据目录，重启能读回旧记录；不同于每次新建临时目录的 Basic 教程
  const workspaceRoot = path.join(options.dataDir, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  // 定义阶段：装配 Agent、模型与存储；此时没有监听端口，也没有向模型提交任务
  return defineServer({
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
}

/** 常驻服务入口：定义后直接 start，退出信号和统一清理由框架管理 */
export async function runExample() {
  const config = readConfig()
  // 第 1 步：先检查模型配置；启动不会采样，实际 Turn 再按冻结配置装配适配器
  createModel()
  // 第 2 步：准备工作区并调用上面的 defineServer，得到尚未启动的服务
  const server = await createExampleServer({
    // 恢复请求带原模型快照；新请求没有快照，工厂才读取当前默认模型
    model: ({ frozenConfig }) => createModel(frozenConfig),
    key: config.key,
    dataDir: config.dataDir,
    corsOrigins: config.corsOrigins,
  })
  // 第 3 步：start 监听端口并返回实际地址；不传参数时使用 127.0.0.1:3000
  // 服务会常驻等待客户端；Ctrl+C / SIGTERM 会结算任务、结束订阅、释放租约并关闭端口
  const url = await server.start({ port: config.port, hostname: config.hostname })
  console.log('Server 地址：', url)
  console.log('API 文档：', `${url}${API_DOCS_PATH}`)
  console.log('示例数据目录：', config.dataDir)
  console.log('Agent：clock，工作区：example')
  console.log('服务已就绪，在另一个终端运行 pnpm client 发起任务，按 Ctrl+C 关闭')
  // 若应用自行决定退出时机，调用 await server.close() 即可，无需分别关闭 HTTP 与 Store
}
