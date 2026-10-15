import type { ServerOptions } from '@elmino/server'
import type { RuntimeStore } from '@elmino/store'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentServer } from '@elmino/server'
import { runtime } from '../runtime/runtime'
import { tools } from '../tool/current-time'

/** 宿主只暴露一个 Agent 和工作区，凭据与路径都留在服务端 */
export function createServer(model: ServerOptions['model'], store: RuntimeStore, workspaceRoot: string, key: string, corsOrigins?: readonly string[]) {
  const agent = defineAgent({
    id: 'clock',
    systemPrompt: '调用 current_time 读取服务端当前时间，再用中文简短说明结果，不重复调用工具',
    runtime,
    tools,
  })
  return AgentServer.create({
    agents: { clock: agent },
    corsOrigins,
    authorize: ({ request }) => request.headers.get('authorization') === `Bearer ${key}`,
    workspace: ({ workspaceId }) => {
      if (workspaceId !== 'example')
        throw new Error('示例只提供 example 工作区')
      return {
        store,
        location: ({ dir = '.' }) => ({
          workspaceId,
          workspaceKind: 'project',
          workspaceRoot,
          dir,
          cwd: path.resolve(workspaceRoot, dir),
        }),
      }
    },
    model,
    onError: error => console.error('服务端执行错误', error),
  })
}
