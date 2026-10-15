import type { ApiTurnCreateInput, ThreadTarget } from '@elmino/api'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ClientOptions } from '@elmino/sdk'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { DefinedTools } from '@elmino/tool'
import type { ServerModelRequest, ServerOptions } from '../../src/index'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'
import { onTestFinished } from 'vitest'
import { createEngineStore, createTestRuntime, disposeEngineStore } from '../../../engine/tests/support/engine'
import { createModel, response } from '../../../engine/tests/support/model'
import { AgentServer } from '../../src/index'

/** Server 集成测试只覆盖实际需要注入的宿主能力 */
interface HarnessOptions {
  /** 两个 Agent 复用同一工具定义，持久归属由 Server 与 Engine 区分 */
  tools?: DefinedTools
  /** 每个真实 RPC 请求进入宿主的授权逻辑 */
  authorize?: ServerOptions['authorize']
  /** 附件和输入预处理在 Engine 接纳范围内执行 */
  prepareInput?: ServerOptions['prepareInput']
  /** 在捕获事实之后运行可失败的宿主观察器 */
  onEvent?: ServerOptions['onEvent']
}

/** 通过公共 SDK 与真实 Server Fetch 连通，Store 生命周期仍由测试宿主持有 */
export async function createServerHarness(options: HarnessOptions = {}) {
  const primary = await createEngineStore()
  const secondary = await createEngineStore()
  const stores = { primary, secondary }
  const models: TurnModel<ModelTurnConfig>[] = []
  const modelRequests: ServerModelRequest[] = []
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
  const serverOptions: ServerOptions = {
    agents,
    authorize: options.authorize,
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
    model: (input) => {
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
  let server = AgentServer.create(serverOptions)
  onTestFinished(async () => {
    try {
      await server.close()
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
      server = AgentServer.create(serverOptions)
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

/** 模型采样可精确停在执行中，并在 Server 中断时按真实 signal 退出 */
export function createGatedModel(text = '任务完成') {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const model = createModel([async (request) => {
    signal = request.signal
    entered.resolve()
    await new Promise<void>((resolve, reject) => {
      /** 只由模型本次采样持有取消监听 */
      const abort = () => {
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      release.promise.then(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      })
      if (signal?.aborted)
        abort()
    })
    return response([{ type: 'text', text }])
  }])
  onTestFinished(() => release.resolve())
  return {
    ...model,
    entered: entered.promise,
    release: () => release.resolve(),
    get signal() { return signal },
  }
}

/** 控制与读取只发送其契约允许的领域归属，不携带创建输入 */
export function threadTarget(request: ApiTurnCreateInput): ThreadTarget {
  return { agentId: request.agentId, workspaceId: request.workspaceId, threadId: request.threadId }
}
