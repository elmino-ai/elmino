import type { Elmino } from '@elmino/core'
import type { ServerListener } from '../node/listen'
import type { ServerOptions, ServerStartOptions } from './types'
import { API_PATH, apiContract, RPC_PATH } from '@elmino/api'
import { ElminoError } from '@elmino/core'
import { throwSettledErrors } from '@elmino/shared'
import { SmartCoercionPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { implement, ORPCError, withEventMeta } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { serverEnvironment, serverStartEnvironment } from '../env/env'
import { RuntimeEventHub } from '../event/hub'

/** 每次 procedure 的网络请求上下文 */
interface Context {
  /** 请求头、取消和宿主授权的来源 */
  request: Request
}

/** -------------------- 核心类 -------------------- */
/** HTTP 与订阅由接入持有，执行继续由共享 Elmino 管理 */
export class AgentServer {
  private readonly _options: ServerOptions
  private readonly _hubs = new Map<string, RuntimeEventHub>()
  private readonly _unsubscribe: () => void
  private readonly _app = new Hono()
  private readonly _requests = new Set<Promise<void>>()
  private _closed = false
  private _closing?: Promise<void>
  private _listener?: Promise<ServerListener>
  private _shutdown?: () => void

  /** 配置在定义时捕获，运行资源在首次访问时加载 */
  private constructor(options: ServerOptions) {
    if (options.apiKey != null && !options.apiKey.trim())
      throw new TypeError('apiKey 不能为空')
    const { ELMINO_SERVER_KEY, ELMINO_CORS_ORIGINS } = serverEnvironment(options)
    this._options = { ...options, apiKey: ELMINO_SERVER_KEY, corsOrigins: ELMINO_CORS_ORIGINS }
    const api = implement(apiContract).$context<Context>()
    const router = api.router({
      meta: {
        health: api.meta.health.handler(async ({ context, input }) => {
          await this._authorize(context, ['meta', 'health'], input)
          return { status: 'ok' as const }
        }),
      },
      agent: {
        list: api.agent.list.handler(async ({ context, input }) => {
          await this._authorize(context, ['agent', 'list'], input)
          return this._options.elmino.listAgents().map(({ id, name, description }) => ({ id, name, description }))
        }),
      },
      thread: {
        list: api.thread.list.handler(async ({ context, input }) => {
          await this._authorize(context, ['thread', 'list'], input)
          return this._call(() => this._options.elmino.listThreads(input))
        }),
        get: api.thread.get.handler(async ({ context, input }) => {
          await this._authorize(context, ['thread', 'get'], input)
          return this._call(() => this._options.elmino.getThread(input))
        }),
      },
      turn: {
        create: api.turn.create.handler(async ({ context, input }) => {
          await this._authorize(context, ['turn', 'create'], input)
          return this._call(() => this._options.elmino.createTurn(input))
        }),
        resume: api.turn.resume.handler(async ({ context, input }) => {
          await this._authorize(context, ['turn', 'resume'], input)
          return this._call(() => this._options.elmino.resumeTurn(input))
        }),
        interrupt: api.turn.interrupt.handler(async ({ context, input }) => {
          await this._authorize(context, ['turn', 'interrupt'], input)
          return this._call(() => this._options.elmino.interruptTurn(input))
        }),
        steer: api.turn.steer.handler(async ({ context, input }) => {
          await this._authorize(context, ['turn', 'steer'], input)
          return this._call(() => this._options.elmino.steerTurn(input))
        }),
      },
      events: {
        subscribe: api.events.subscribe.handler(async ({ context, input, signal, lastEventId }) => {
          await this._authorize(context, ['events', 'subscribe'], input)
          await this._call(async () => {
            if (input.threadId)
              await this._options.elmino.getThread({ ...input, threadId: input.threadId })
            else
              await this._options.elmino.openWorkspace(input)
          })
          // 资源打开期间可能关闭，失败请求不能留下窗口或创建无法结束的新订阅
          if (this._closed || this._options.elmino.closed)
            throw new ORPCError('SERVICE_UNAVAILABLE')
          const key = JSON.stringify([input.agentId, input.workspaceId])
          let hub = this._hubs.get(key)
          if (!hub) {
            hub = RuntimeEventHub.create({ maxBytes: this._options.eventBufferBytes })
            this._hubs.set(key, hub)
          }
          const events = hub
          /** 每个 Server 拥有自己的回放窗口，取消订阅不撤销 Elmino 执行 */
          async function* stream() {
            for await (const frame of events.subscribe(lastEventId, signal, { threadId: input.threadId }))
              yield withEventMeta(frame.message, { id: frame.cursor })
          }
          return stream()
        }),
      },
    })
    const rpc = new RPCHandler(router, { plugins: [new BatchHandlerPlugin({ maxSize: 10 })] })
    const converter = new ZodToJsonSchemaConverter({
      interceptors: [({ schema, next }) => {
        // 自定义运行校验的结构说明归 Schema 所有者，不让协议层依赖 HTTP 适配器
        const metadata = z.globalRegistry.get(schema)
        const jsonSchema = metadata?.jsonSchema as ReturnType<ZodToJsonSchemaConverter['convert']>[1] | undefined
        if (!jsonSchema)
          return next()
        // JSON/片段的结构仍由领域定义；使用方添加的字段说明与示例不能被覆盖
        const description = metadata?.description ?? jsonSchema.description
        const examples = Array.isArray(metadata?.examples) ? metadata.examples : jsonSchema.examples
        const title = metadata?.title ?? jsonSchema.title
        return [true, { ...jsonSchema, description, examples, title }]
      }],
    })
    const reference = options.apiReference
    const security = ELMINO_SERVER_KEY === undefined ? [] : [{ bearerAuth: [] }]
    const description = options.authorize
      ? 'Agent 运行与事件接口，访问还需通过宿主 authorize 授权，身份传递方式由宿主决定'
      : ELMINO_SERVER_KEY === undefined
        ? 'Agent 运行与事件接口，当前服务未启用固定 Bearer 凭据'
        : 'Agent 运行与事件接口，请使用已配置的 Bearer 凭据访问业务接口'
    const openapi = new OpenAPIHandler(router, {
      plugins: [
        new SmartCoercionPlugin({ schemaConverters: [converter] }),
        ...(reference === false
          ? []
          : [new OpenAPIReferencePlugin({
              docsPath: '/docs',
              specPath: '/spec.json',
              docsTitle: reference?.title ?? 'Elmino API',
              schemaConverters: [converter],
              specGenerateOptions: {
                info: { title: reference?.title ?? 'Elmino API', version: reference?.version ?? '0.0.0', description },
                components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
                security,
              },
            })]),
      ],
    })
    if (ELMINO_CORS_ORIGINS.length) {
      this._app.use('*', cors({
        origin: ELMINO_CORS_ORIGINS,
        allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID', 'X-ORPC-Batch'],
        exposeHeaders: ['Content-Type'],
      }))
    }
    // 自定义路由与内置 API 共用关闭门禁和请求结算，不允许关闭后再打开执行资源
    this._app.use('*', async (context, next) => {
      if (this._closed || this._options.elmino.closed)
        return context.json({ code: 'SERVICE_UNAVAILABLE', message: 'Server 已关闭' }, 503)
      const request = next()
      this._requests.add(request)
      try {
        return await request
      }
      finally {
        this._requests.delete(request)
      }
    })
    this._app.onError(async (error, context) => {
      await this._report(error)
      return context.json({ code: 'INTERNAL_SERVER_ERROR', message: '服务请求失败' }, 500)
    })
    // 在挂载 API 前配置，宿主中间件才能包住 REST、RPC 与事件流
    options.http?.(this._app)
    this._app.use(`${RPC_PATH}/*`, async (context, next) => {
      const result = await rpc.handle(context.req.raw, { prefix: RPC_PATH, context: { request: context.req.raw } })
      if (result.matched)
        return result.response
      return next()
    })
    this._app.use(`${API_PATH}/*`, async (context, next) => {
      const result = await openapi.handle(context.req.raw, { prefix: API_PATH, context: { request: context.req.raw } })
      if (result.matched)
        return result.response
      return next()
    })
    this._unsubscribe = options.elmino.subscribe({
      onEvent: (target, event) => {
        this._hubs.get(JSON.stringify([target.agentId, target.workspaceId]))?.publish(event)
      },
      onClose: () => {
        for (const hub of this._hubs.values())
          hub.close()
      },
    })
  }

  /** 当前接入借用的应用实例，生命周期仍归创建方 */
  public get elmino(): Elmino {
    return this._options.elmino
  }

  /** 创建 HTTP 接入；不会取得传入 Elmino 的资源所有权 */
  public static create(options: ServerOptions): AgentServer {
    return new AgentServer(options)
  }

  /** 启动独立 Node 服务并返回实际地址；重复调用复用首次监听，关闭后不能重启 */
  public async start(options: ServerStartOptions = {}): Promise<string> {
    if (this._closed)
      throw new Error('Server 已关闭，请重新定义服务后启动')
    const { shutdownSignals = true } = options
    // 只在独立启动时加载 Node HTTP 适配器；Fetch 宿主不会注册端口或退出信号
    this._listener ??= (async () => {
      const { ELMINO_PORT: port, ELMINO_HOST: hostname } = serverStartEnvironment(options)
      const { listen } = await import('../node/listen')
      if (this._closed)
        throw new Error('Server 已关闭，启动已取消')
      const listener = await listen({ server: this, port, hostname })
      if (!this._closed && shutdownSignals) {
        this._shutdown = () => {
          this.close().catch(async (error) => {
            process.exitCode = 1
            if (this._options.onError)
              await this._report(error)
            else
              console.error('关闭 Agent Server 失败', error)
          })
        }
        process.on('SIGINT', this._shutdown)
        process.on('SIGTERM', this._shutdown)
      }
      return listener
    })()
    try {
      const listener = await this._listener
      if (this._closed)
        throw new Error('Server 已关闭，启动已取消')
      return listener.url
    }
    catch (error) {
      const cleanup = await Promise.allSettled([this.close()])
      throwSettledErrors([{ status: 'rejected', reason: error }, ...cleanup], '启动 Server 与资源清理均失败', true)
      throw error
    }
  }

  /** 可直接交给 Hono、Node 适配器或其他 Fetch 宿主，无需调用 start */
  public fetch(request: Request): Promise<Response> {
    // Hono 可同步或异步响应，公开入口统一返回 Promise；请求结算由 Hono 中间件跟踪
    return Promise.resolve(this._app.fetch(request))
  }

  /** 结束本接入的请求、订阅和 HTTP 监听，不关闭共享 Elmino */
  public close(): Promise<void> {
    if (this._closing)
      return this._closing
    this._closed = true
    // 先发布唯一关闭 Promise，重复关闭始终等待同一个结果
    this._closing = Promise.resolve().then(async () => {
      this._unsubscribe()
      for (const hub of this._hubs.values())
        hub.close()
      const results = await Promise.allSettled(this._requests)
      // 等待尚未完成的监听；启动失败由 start 报告，不重复计入关闭错误
      const [opened] = await Promise.allSettled([this._listener])
      if (opened.status === 'fulfilled' && opened.value)
        results.push(...await Promise.allSettled([opened.value.close()]))
      if (this._shutdown) {
        process.off('SIGINT', this._shutdown)
        process.off('SIGTERM', this._shutdown)
      }
      throwSettledErrors(results, '关闭 Agent Server 失败')
    })
    return this._closing
  }

  private async _authorize(context: Context, path: readonly string[], input: unknown) {
    if (this._closed || this._options.elmino.closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
    if (this._options.apiKey != null && context.request.headers.get('authorization') !== `Bearer ${this._options.apiKey}`)
      throw new ORPCError('UNAUTHORIZED')
    if (this._options.authorize && !await this._options.authorize({ request: context.request, path, input }))
      throw new ORPCError('UNAUTHORIZED')
    if (this._closed || this._options.elmino.closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
  }

  private async _call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    }
    catch (cause) {
      if (cause instanceof ElminoError)
        throw new ORPCError(cause.code, { message: cause.message, cause })
      throw cause
    }
  }

  private async _report(error: unknown) {
    try {
      await this._options.onError?.(error)
    }
    catch {
      // 错误观察器不能制造未处理的 Promise 拒绝
    }
  }
}

/** 定义 Agent 服务；独立运行调用 start，嵌入已有 HTTP 服务使用 fetch */
export function defineServer(options: ServerOptions): AgentServer {
  return AgentServer.create(options)
}
