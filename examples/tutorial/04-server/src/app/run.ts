/**
 * Tutorial 04 · 启动 Agent Server · 从这里开始阅读
 *
 * 本例要讲：分别定义 Elmino 应用与 HTTP Server，掌握启动、文档和资源关闭
 * 运行命令：pnpm example:server
 * 预期结果：Server 常驻等待请求；打开打印出的 /api/docs 即可查看与调用接口
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
import type { ElminoOptions } from '@elmino/core'
import { fileURLToPath } from 'node:url'
import { API_DOCS_PATH } from '@elmino/api/paths'
import { defineElmino } from '@elmino/core'
import { defineServer } from '@elmino/server'
import { sqliteStore } from '@elmino/store-sqlite'
import { clock } from '../agent/clock'
import { createModel } from '../model/deepseek'

/** 只注入模型以便确定性测试；Server 和 SQLite 在各自入口读取环境变量 */
export function createExampleServer(models: ElminoOptions['models']) {
  // 工作区是本示例的项目目录；SQLite 运行数据由 ELMINO_DATA_DIR 或默认 .elmino 决定
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
  // 定义阶段：装配 Agent、模型与存储；此时没有监听端口，也没有向模型提交任务
  const elmino = defineElmino({
    // 客户端按 agentId: clock 选择定义，这个注册键必须与 clock.id 相同
    agents: { clock },
    // 固定工作区接纳 workspaceId: example；存储按需打开，由 Elmino 生命周期释放
    workspace: { id: 'example', rootDir: workspaceRoot, store: sqliteStore() },
    // 宿主在新任务或恢复时装配模型，HTTP 客户端不携带模型 API Key
    models,
    onError: error => console.error('Agent 执行错误', error),
  })
  return defineServer({
    elmino,
    // ELMINO_SERVER_KEY 可选；未设置时不启用固定凭据，CORS 也由 Server 自行读取
    onError: error => console.error('服务端执行错误', error),
  })
}

/** 常驻服务入口：分别创建应用与接入，由示例宿主统一处理退出 */
export async function runExample() {
  // 第 1 步：先检查模型配置；启动不会采样，实际 Turn 再按冻结配置装配适配器
  createModel()
  // 第 2 步：准备工作区并调用上面的 defineServer，得到尚未启动的服务
  const server = createExampleServer({
    // 恢复请求带原模型快照；新请求没有快照，工厂才读取当前默认模型
    deepseek: ({ frozenConfig }) => createModel(frozenConfig),
  })
  // 第 3 步：start 自动读取 ELMINO_HOST / ELMINO_PORT；未配置时监听 127.0.0.1:3000
  // 服务常驻等待客户端；应用统一处理退出，Server 不会擅自关闭传入的 Elmino
  const url = await server.start({ shutdownSignals: false })
  console.log('Server 地址：', url)
  console.log('API 文档：', `${url}${API_DOCS_PATH}`)
  console.log('Agent：clock，工作区：example')
  console.log('服务已就绪，在另一个终端回到仓库根目录运行 pnpm example:sdk 发起任务，按 Ctrl+C 关闭')
  // 第 4 步：创建方负责两者的退出；并行关闭让 Engine 取消能够解除尚未完成的请求
  const shutdown = () => {
    Promise.allSettled([server.close(), server.elmino.close()]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('关闭应用失败', result.reason)
          process.exitCode = 1
        }
      }
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
