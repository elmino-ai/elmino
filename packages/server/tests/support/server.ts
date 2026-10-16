import type { ApiTurnCreateInput, ThreadTarget } from '@elmino/api'
import type { ElminoOptions, ModelRequest } from '@elmino/core'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ClientOptions } from '@elmino/sdk'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { DefinedTools } from '@elmino/tool'
import type { ServerOptions } from '../../src/index'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { defineElmino } from '@elmino/core'
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'
import { onTestFinished } from 'vitest'
import { createEngineStore, createTestRuntime, disposeEngineStore } from '../../../engine/tests/support/engine'
import { defineServer } from '../../src/index'

export { createGatedModel } from '../../../engine/tests/support/gated-model'

/** Server 集成测试只覆盖实际需要注入的宿主能力 */
interface HarnessOptions {
  /** 两个 Agent 复用同一工具定义，持久归属由 Server 与 Engine 区分 */
  tools?: DefinedTools
  /** 每个真实 RPC 请求进入宿主的授权逻辑 */
  authorize?: ServerOptions['authorize']
  /** 附件和输入预处理在 Engine 接纳范围内执行 */
  prepareInput?: ElminoOptions['prepareInput']
  /** 在捕获事实之后运行可失败的宿主观察器 */
  onEvent?: ElminoOptions['onEvent']
  /** 真实 SSE 与普通 HTTP 响应共用的跨域配置 */
  corsOrigins?: ServerOptions['corsOrigins']
}

/** 通过公共 SDK 与真实 Server Fetch 连通，Store 生命周期仍由测试宿主持有 */
export async function createServerHarness(options: HarnessOptions = {}) {
  const primary = await createEngineStore()
  const secondary = await createEngineStore()
  const stores = { primary, secondary }
  const models: TurnModel<ModelTurnConfig>[] = []
  const modelRequests: ModelRequest[] = []
  const events: RuntimeEvent[] = []
  const captureErrors: unknown[] = []
  const errors: unknown[] = []
  const requests: Request[] = []
  const agents = Object.fromEntries(['alpha', 'beta'].map(id => [id, defineAgent({
    id,
    systemPrompt: '完成当前任务',
    tools: options.tools,
    runtime: { create: ({ location }) => createTestRuntime(location) },
  })]))
  const elminoOptions: ElminoOptions = {
    agents,
    prepareInput: options.prepareInput,
    workspace: ({ workspaceId }) => {
      const resource = workspaceId === 'secondary' ? secondary : primary
      return {
        store: resource.store,
        location: ({ dir = '.' }) => ({
          workspaceId,
          workspaceKind: 'project',
          workspaceRoot: resource.root,
          dir,
          cwd: path.resolve(resource.root, dir),
        }),
      }
    },
    models: (input) => {
      modelRequests.push({
        ...input,
        frozenConfig: input.frozenConfig ? structuredClone(input.frozenConfig) : undefined,
      })
      const model = models.shift()
      if (!model)
        throw new Error('模型解析超过预设队列')
      return model
    },
    onEvent: async (target, event) => {
      try {
        events.push(structuredClone(event))
      }
      catch (cause) {
        captureErrors.push(cause)
      }
      await options.onEvent?.(target, event)
    },
    onError: (error) => { errors.push(error) },
  }
  let elmino = defineElmino(elminoOptions)
  const serverOptions = { apiKey: null, authorize: options.authorize, corsOrigins: options.corsOrigins ?? [] }
  let server = defineServer({ ...serverOptions, elmino })
  onTestFinished(async () => {
    try {
      await server.close()
      await elmino.close()
    }
    finally {
      await Promise.all(Object.values(stores).map(resource => disposeEngineStore(resource.root, resource.store)))
    }
  })
  return {
    stores,
    models,
    modelRequests,
    events,
    captureErrors,
    errors,
    requests,
    get server() { return server },
    get elmino() { return elmino },
    client(headers?: ClientOptions['headers']) {
      return Client.create({
        baseUrl: 'https://elmino.test',
        headers,
        fetch: (input, init) => {
          const request = new Request(input, init)
          requests.push(request)
          return server.fetch(request)
        },
        retry: { initialDelayMs: 5, maxDelayMs: 20 },
      })
    },
    async restart() {
      await server.close()
      await elmino.close()
      elmino = defineElmino(elminoOptions)
      server = defineServer({ ...serverOptions, elmino })
    },
    request(overrides: Partial<ApiTurnCreateInput> = {}): ApiTurnCreateInput {
      return {
        agentId: 'alpha',
        workspaceId: 'primary',
        threadId: createId('thread'),
        turnId: createId('turn'),
        input: [{ type: 'text', text: '执行任务' }],
        approvalMode: 'fullAccess',
        ...overrides,
      }
    },
  }
}

/** 控制与读取只发送其契约允许的领域归属，不携带创建输入 */
export function threadTarget(request: ApiTurnCreateInput): ThreadTarget {
  return { agentId: request.agentId, workspaceId: request.workspaceId, threadId: request.threadId }
}

/** 健康与鉴权请求不应打开任何工作区或模型资源 */
export function createEmptyServer(options: Omit<ServerOptions, 'elmino'> = {}) {
  const elmino = defineElmino({
    agents: {},
    workspace: () => { throw new Error('健康请求不应打开工作区') },
    models: () => { throw new Error('健康请求不应装配模型') },
  })
  onTestFinished(() => elmino.close())
  return defineServer({ apiKey: null, corsOrigins: [], ...options, elmino })
}
