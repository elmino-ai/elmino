import type { AddressInfo } from 'node:net'
import type { AgentServer } from '../server/server'
import { once } from 'node:events'
import { serve } from '@hono/node-server'

/** Node HTTP 监听配置，不拥有模型或 Store */
export interface ListenOptions {
  /** 已创建的框架服务 */
  server: AgentServer
  /** 默认随机可用端口 */
  port?: number
  /** 默认仅本机访问 */
  hostname?: string
}

/** 已打开的 HTTP 端口，AgentServer 生命周期由创建方管理 */
export interface ServerListener {
  /** 实际监听地址 */
  url: string
  /** 关闭 HTTP 连接，不关闭宿主持有的 Store */
  close: () => Promise<void>
}

/**
 * 打开本机 HTTP 端口，失败时抛出实际监听错误
 */
export async function listen(options: ListenOptions): Promise<ServerListener> {
  // 缺省只监听本机；向局域网开放由宿主显式选择
  const hostname = options.hostname ?? '127.0.0.1'
  // 适配器只接入 HTTP 请求，不取得 AgentServer 或 Elmino 的关闭权
  const server = serve({ fetch: request => options.server.fetch(request), port: options.port ?? 0, hostname })
  await once(server, 'listening')
  // 随机端口必须等 listening 后读取真实绑定结果
  const address = server.address() as AddressInfo
  // 重复关闭共享同一任务，避免对原生 Server 多次发起关闭
  let closing: Promise<void> | undefined
  return {
    url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`,
    /** 关闭监听及活动 HTTP 连接，不触碰宿主持有的执行资源 */
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        if ('closeAllConnections' in server)
          server.closeAllConnections()
      })
      return closing
    },
  }
}
