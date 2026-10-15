import type { Agent } from '@elmino/agent'
import type {
  AgentWorkspaceTarget,
  ApiThreadListInput,
  ApiTurnCreateInput,
  ApiTurnInterruptInput,
  ApiTurnResumeInput,
  ApiTurnSteerInput,
  ThreadTarget,
} from '@elmino/api'
import type { TurnExecution, TurnInputPart } from '@elmino/engine'
import type { RuntimeStore, RuntimeStoreLease, RuntimeThreadRecord } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { ServerListener } from '../node/listen'
import type { ServerOptions, ServerStartOptions, ServerWorkspace } from './types'
import path from 'node:path'
import { API_DOCS_PATH, API_PATH, API_SPEC_PATH, apiContract, RPC_PATH } from '@elmino/api'
import { AgentEngine } from '@elmino/engine'
import { throwSettledErrors } from '@elmino/shared'
import { isPathWithin } from '@elmino/shared/node'
import {
  hydrateThreadMessages,
  readThreadSnapshot,
  readThreadUsage,
  runtimeRecordsToThreadListItem,
} from '@elmino/thread'
import { SmartCoercionPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { implement, ORPCError, withEventMeta } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { z } from 'zod'
import { RuntimeEventHub } from '../event/hub'

/** 一个 Agent / 工作区的独立执行与回放生命周期 */
interface Scope {
  /** 作用域固定身份 */
  target: AgentWorkspaceTarget
  /** 已打开的工作区资源 */
  workspace: ServerWorkspace
  /** 配置借出的 Store，Engine 结算并关闭后释放 */
  lease?: RuntimeStoreLease
  /** 当前执行定义 */
  agent: Agent
  /** 当前作用域执行引擎 */
  engine: AgentEngine
  /** 当前作用域事件流 */
  events: RuntimeEventHub
  /** 前台、后台和控制操作共用的唯一事件出口 */
  emit: (event: RuntimeEvent) => Promise<void>
}

/** 每次 procedure 的网络请求上下文 */
interface Context {
  /** 请求头、取消和宿主授权的来源 */
  request: Request
}

/** -------------------- 核心类 -------------------- */
/** 执行与订阅由服务持有，HTTP 断开不会撤销已经接纳的任务 */
export class AgentServer {
  private readonly _options: ServerOptions
  private readonly _scopes = new Map<string, Promise<Scope>>()
  private readonly _storeWorkspaces = new WeakMap<ServerWorkspace['store'], string>()
  private readonly _handler: RPCHandler<Context>
  private readonly _openapi: OpenAPIHandler<Context>
  private readonly _requests = new Set<Promise<Response>>()
  private readonly _lifetime = new AbortController()
  private _closed = false
  private _closing?: Promise<void>
  private _listener?: Promise<ServerListener>
  private _shutdown?: () => void

  /** 配置在定义时捕获，运行资源在首次访问时加载 */
  public constructor(options: ServerOptions) {
    for (const [key, agent] of Object.entries(options.agents)) {
      if (key !== agent.id)
        throw new TypeError('Agent 注册键必须与定义中的 id 一致')
    }
    if (options.apiKey !== undefined && !options.apiKey.trim())
      throw new TypeError('apiKey 不能为空')
    if (typeof options.workspace !== 'function' && !options.workspace.id.trim())
      throw new TypeError('工作区 id 不能为空')
    this._options = {
      ...options,
      agents: { ...options.agents },
      workspace: typeof options.workspace === 'function'
        ? options.workspace
        : { ...options.workspace, rootDir: path.resolve(options.workspace.rootDir) },
    }
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
          return Object.values(this._options.agents).map(({ id, name, description }) => ({ id, name, description }))
        }),
      },
      thread: {
        list: api.thread.list.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['thread', 'list'], input)
          return this._list(scope, input)
        }),
        get: api.thread.get.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['thread', 'get'], input)
          return this._state(scope, input.threadId)
        }),
      },
      turn: {
        create: api.turn.create.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['turn', 'create'], input)
          return this._create(scope, input)
        }),
        resume: api.turn.resume.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['turn', 'resume'], input)
          return this._resume(scope, input)
        }),
        interrupt: api.turn.interrupt.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['turn', 'interrupt'], input)
          return this._interrupt(scope, input)
        }),
        steer: api.turn.steer.handler(async ({ context, input }) => {
          const scope = await this._scope(context, ['turn', 'steer'], input)
          return this._steer(scope, input)
        }),
      },
      events: {
        subscribe: api.events.subscribe.handler(async ({ context, input, signal, lastEventId }) => {
          const scope = await this._scope(context, ['events', 'subscribe'], input)
          if (input.threadId)
            await this._thread(scope, input.threadId)
          /** oRPC 仅承载游标，队列与订阅清理仍归 Hub */
          async function* stream() {
            for await (const frame of scope.events.subscribe(lastEventId, signal, { threadId: input.threadId }))
              yield withEventMeta(frame.message, { id: frame.cursor })
          }
          return stream()
        }),
      },
    })
    this._handler = new RPCHandler(router, { plugins: [new BatchHandlerPlugin({ maxSize: 10 })] })
    const converter = new ZodToJsonSchemaConverter({
      interceptors: [({ schema, next }) => {
        // 自定义运行校验的结构说明归 Schema 所有者，不让协议层依赖 HTTP 适配器
        const jsonSchema = z.globalRegistry.get(schema)?.jsonSchema as ReturnType<ZodToJsonSchemaConverter['convert']>[1] | undefined
        return jsonSchema ? [true, jsonSchema] : next()
      }],
    })
    const reference = options.apiReference
    this._openapi = new OpenAPIHandler(router, {
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
                info: { title: reference?.title ?? 'Elmino API', version: reference?.version ?? '0.0.0' },
                components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
                security: [{ bearerAuth: [] }],
              },
            })]),
      ],
    })
  }

  /** 启动独立 Node 服务并返回实际地址；重复调用复用首次监听，关闭后不能重启 */
  public async start(options: ServerStartOptions = {}): Promise<string> {
    if (this._closed)
      throw new Error('Server 已关闭，请重新定义服务后启动')
    const { port = 3000, hostname, shutdownSignals = true } = options
    // 只在独立启动时加载 Node HTTP 适配器；Fetch 宿主不会注册端口或退出信号
    this._listener ??= (async () => {
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
    const task = this._handle(request)
    if (!this._closed) {
      this._requests.add(task)
      task.finally(() => this._requests.delete(task)).catch(() => undefined)
    }
    return task
  }

  private async _handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin')
    const allowedOrigin = origin && this._options.corsOrigins?.includes(origin) ? origin : undefined
    if (request.method === 'OPTIONS' && allowedOrigin)
      return new Response(null, { status: 204, headers: this._corsHeaders(allowedOrigin) })
    const pathname = new URL(request.url).pathname.replace(/\/$/, '')
    let response: Response
    if (this._closed && (pathname === API_DOCS_PATH || pathname === API_SPEC_PATH)) {
      response = Response.json({ code: 'SERVICE_UNAVAILABLE', message: 'Server 已关闭' }, { status: 503 })
    }
    else {
      const rpc = await this._handler.handle(request, { prefix: RPC_PATH, context: { request } })
      const result = rpc.matched ? rpc : await this._openapi.handle(request, { prefix: API_PATH, context: { request } })
      response = result.matched ? result.response : new Response('Not Found', { status: 404 })
    }
    if (!allowedOrigin)
      return response
    const headers = new Headers(response.headers)
    for (const [key, value] of this._corsHeaders(allowedOrigin))
      headers.set(key, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  /** 结算 Engine、订阅和租约，再关闭 start 打开的端口；重复调用共享同一关闭结果 */
  public close(): Promise<void> {
    if (this._closing)
      return this._closing
    this._closed = true
    // 先发布唯一关闭 Promise，再通知宿主，允许 abort 监听同步重入 close
    this._closing = Promise.resolve().then(async () => {
      this._lifetime.abort()
      const scopes = await Promise.allSettled(this._scopes.values())
      const results = await Promise.allSettled([...this._requests, ...scopes.flatMap(result => result.status === 'fulfilled'
        ? [(async () => {
            const cleanup = await Promise.allSettled([(async () => {
              await result.value.engine.close()
            })()])
            result.value.events.close()
            cleanup.push(...await Promise.allSettled([(async () => {
              await result.value.lease?.release()
            })()]))
            throwSettledErrors(cleanup, '关闭工作区失败', true)
          })()]
        : [])])
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
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
    if (this._options.apiKey !== undefined && context.request.headers.get('authorization') !== `Bearer ${this._options.apiKey}`)
      throw new ORPCError('UNAUTHORIZED')
    if (this._options.authorize && !await this._options.authorize({ request: context.request, path, input }))
      throw new ORPCError('UNAUTHORIZED')
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
  }

  private async _scope(context: Context, path: readonly string[], input: AgentWorkspaceTarget) {
    await this._authorize(context, path, input)
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
    const key = JSON.stringify([input.agentId, input.workspaceId])
    let pending = this._scopes.get(key)
    if (!pending) {
      pending = this._createScope({ agentId: input.agentId, workspaceId: input.workspaceId })
      this._scopes.set(key, pending)
      pending.catch(() => {
        if (this._scopes.get(key) === pending)
          this._scopes.delete(key)
      })
    }
    const scope = await pending
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
    return scope
  }

  private async _createScope(target: AgentWorkspaceTarget): Promise<Scope> {
    const agent = Object.hasOwn(this._options.agents, target.agentId) ? this._options.agents[target.agentId] : undefined
    if (!agent)
      throw new ORPCError('NOT_FOUND', { message: 'Agent 不存在' })
    const definition = this._options.workspace
    const events = RuntimeEventHub.create({ maxBytes: this._options.eventBufferBytes })
    let lease: RuntimeStoreLease | undefined
    let engine: AgentEngine | undefined
    try {
      let workspace: ServerWorkspace
      if (typeof definition === 'function') {
        workspace = await definition({ ...target, signal: this._lifetime.signal })
      }
      else {
        if (target.workspaceId !== definition.id)
          throw new ORPCError('NOT_FOUND', { message: '工作区不存在' })
        const source = definition.store
        let store: RuntimeStore
        if (typeof source === 'function') {
          lease = await source(this._lifetime.signal)
          store = lease.store
        }
        else {
          store = source
        }
        workspace = {
          store,
          location: ({ dir = '.' }) => {
            const cwd = path.resolve(definition.rootDir, dir)
            if (path.isAbsolute(dir) || !isPathWithin(definition.rootDir, cwd))
              throw new Error('线程执行目录必须位于工作区内')
            return {
              workspaceId: definition.id,
              workspaceKind: 'project',
              workspaceRoot: definition.rootDir,
              dir,
              cwd,
            }
          },
        }
      }
      if (this._closed)
        throw new ORPCError('SERVICE_UNAVAILABLE')
      const owner = this._storeWorkspaces.get(workspace.store)
      if (owner !== undefined && owner !== target.workspaceId)
        throw new Error('同一 RuntimeStore 不能同时属于不同工作区')
      this._storeWorkspaces.set(workspace.store, target.workspaceId)
      /** 所有执行入口都使用同一个发布出口 */
      const emit = async (event: RuntimeEvent) => {
        events.publish(event)
        try {
          await this._options.onEvent?.(target, event)
        }
        catch (error) {
          await this._report(error)
        }
      }
      engine = AgentEngine.create({ [agent.id]: agent }, {
        ...this._options.engine,
        restoreModel: config => this._options.model({ ...target, frozenConfig: config, signal: this._lifetime.signal }),
        onRuntimeEvent: (_agentId, event) => emit(event),
      })
      await engine.recoverWorkspace({
        agentId: agent.id,
        store: workspace.store,
        threadLocation: ({ id, dir }) => workspace.location({ threadId: id, dir }),
      })
      return { target, workspace, agent, engine, events, emit, lease }
    }
    catch (error) {
      const cleanup = await Promise.allSettled([(async () => {
        await engine?.close()
      })()])
      events.close()
      cleanup.push(...await Promise.allSettled([(async () => {
        await lease?.release()
      })()]))
      const errors = cleanup.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length > 0)
        await this._report(new AggregateError([error, ...errors], '打开工作区和资源关闭均失败'))
      throw error
    }
  }

  private async _thread(scope: Scope, threadId: string, optional = false) {
    const record = await scope.workspace.store.threads.read(threadId)
    if (!record && optional)
      return
    if (!record || record.agentId !== scope.target.agentId || record.metadata.workspaceId !== scope.target.workspaceId
      || record.lifecycle !== 'active') {
      throw new ORPCError('NOT_FOUND', { message: '线程不存在' })
    }
    return record
  }

  private async _location(scope: Scope, threadId: string, record?: RuntimeThreadRecord) {
    const location = await scope.workspace.location({ threadId, dir: record?.dir })
    if (location.workspaceId !== scope.target.workspaceId || (record && location.dir !== record.dir))
      throw new Error('宿主返回的位置与线程工作区或持久化目录不一致')
    return location
  }

  private async _state(scope: Scope, threadId: string) {
    const record = (await this._thread(scope, threadId))!
    const { store } = scope.workspace
    const location = await this._location(scope, threadId, record)
    const [snapshot, messages, turns, children, usage] = await Promise.all([
      readThreadSnapshot(store, threadId, location),
      hydrateThreadMessages({ store, threadId }),
      store.turns.list(threadId),
      scope.engine.listChildren({ agentId: scope.agent.id, parentThreadId: threadId, store }),
      readThreadUsage(store, threadId),
    ])
    if (!snapshot)
      throw new ORPCError('NOT_FOUND')
    return scope.agent.thread.toState(snapshot, {
      messages: scope.engine.mergeThreadMessages(threadId, messages),
      turns: turns.map(turn => ({
        id: turn.id,
        status: turn.status,
        agentId: scope.agent.id,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      })),
      children,
      taskUsage: usage.taskUsage,
    })
  }

  private async _list(scope: Scope, input: ApiThreadListInput) {
    const { store } = scope.workspace
    const page = await store.threads.page({ agentId: input.agentId, archived: input.archived ?? false, limit: input.limit ?? 50 })
    // 一个 RuntimeStore 属于一个工作区，按当前作用域过滤所有返回记录
    const records = page.items.filter(record => record.metadata.workspaceId === input.workspaceId)
    const latest = await store.turns.latest(records.map(record => record.id))
    const byId = new Map(latest.map(turn => [turn.threadId, turn]))
    return { items: records.map(record => runtimeRecordsToThreadListItem(record, byId.get(record.id))), hasMore: page.hasMore }
  }

  private async _create(scope: Scope, input: ApiTurnCreateInput) {
    const record = await this._thread(scope, input.threadId, true)
    const location = await this._location(scope, input.threadId, record)
    const model = await this._options.model({ ...scope.target, modelId: input.modelId ?? record?.settings.modelId, signal: this._lifetime.signal })
    return this._accept(scope, input, scope.engine.run({
      agentId: input.agentId,
      threadId: input.threadId,
      turnId: input.turnId,
      model,
      location,
      input: () => {
        if (this._options.prepareInput) {
          return this._options.prepareInput(input.input, {
            ...scope.target,
            threadId: input.threadId,
            location,
            store: scope.workspace.store,
          })
        }
        return input.input.map((part): TurnInputPart => {
          if (part.type === 'document')
            throw new ORPCError('BAD_REQUEST', { message: '文档输入需要宿主提供 prepareInput' })
          return part
        })
      },
      onRuntimeEvent: scope.emit,
      approvalMode: input.approvalMode,
      subagentMode: input.subagentMode,
    }, scope.workspace.store))
  }

  private async _resume(scope: Scope, input: ApiTurnResumeInput) {
    const record = (await this._thread(scope, input.threadId))!
    const turn = await scope.workspace.store.turns.read(input.turnId)
    if (!turn || turn.threadId !== input.threadId || turn.agentSnapshot.id !== input.agentId)
      throw new ORPCError('NOT_FOUND', { message: 'Turn 不存在' })
    if (turn.status !== 'interrupted' || turn.interrupt?.id !== input.interruptId)
      throw new ORPCError('CONFLICT', { message: '当前中断已失效或不可恢复' })
    const location = await this._location(scope, input.threadId, record)
    const model = await this._options.model({ ...scope.target, frozenConfig: turn.modelConfig, signal: this._lifetime.signal })
    return this._accept(scope, input, scope.engine.resume({
      agentId: input.agentId,
      threadId: input.threadId,
      turnId: input.turnId,
      model,
      location,
      input: [],
      onRuntimeEvent: scope.emit,
      resume: { interruptId: input.interruptId, response: input.response },
    }, scope.workspace.store))
  }

  private async _accept(scope: Scope, input: ThreadTarget, execution: TurnExecution) {
    execution.completed.catch(error => this._report(error))
    try {
      await execution.accepted
    }
    catch (cause) {
      if (cause instanceof ORPCError)
        throw cause
      throw new ORPCError('CONFLICT', { message: cause instanceof Error ? cause.message : '任务未被接纳', cause })
    }
    return this._state(scope, input.threadId)
  }

  private async _interrupt(scope: Scope, input: ApiTurnInterruptInput) {
    await this._thread(scope, input.threadId)
    await scope.engine.interrupt({ ...input, store: scope.workspace.store })
    return this._state(scope, input.threadId)
  }

  private async _steer(scope: Scope, input: ApiTurnSteerInput) {
    await this._thread(scope, input.threadId)
    try {
      return await scope.engine.steer({ ...input, store: scope.workspace.store })
    }
    catch (cause) {
      throw new ORPCError('CONFLICT', { message: cause instanceof Error ? cause.message : '当前任务无法接收引导', cause })
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

  private _corsHeaders(origin: string) {
    return new Headers({
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, last-event-id, x-orpc-batch',
      'access-control-expose-headers': 'content-type',
      'vary': 'Origin',
    })
  }
}

/** 定义 Agent 服务；独立运行调用 start，嵌入已有 HTTP 服务使用 fetch */
export function defineServer(options: ServerOptions): AgentServer {
  return new AgentServer(options)
}
