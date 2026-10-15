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

/** 打开本机 HTTP 端口，失败时抛出实际监听错误 */
export async function listen(options: ListenOptions): Promise<ServerListener> {
  const hostname = options.hostname ?? '127.0.0.1'
  const server = serve({ fetch: request => options.server.fetch(request), port: options.port ?? 0, hostname })
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  let closing: Promise<void> | undefined
  return {
    url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`,
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
