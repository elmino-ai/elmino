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
import type { RuntimeThreadRecord } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread/events'
import type { ServerOptions, ServerWorkspace } from './types'
import { API_DOCS_PATH, API_PATH, API_SPEC_PATH, apiContract, RPC_PATH } from '@elmino/api'
import { AgentEngine } from '@elmino/engine'
import { throwSettledErrors } from '@elmino/shared'
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
  /** 宿主资源，不由 Server 关闭 */
  workspace: ServerWorkspace
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

  /** 创建尚未打开网络端口的 Fetch 服务，工作区在第一次访问时恢复 */
  public static create(options: ServerOptions) {
    return new AgentServer(options)
  }

  private constructor(options: ServerOptions) {
    for (const [key, agent] of Object.entries(options.agents)) {
      if (key !== agent.id)
        throw new TypeError('Agent 注册键必须与定义中的 id 一致')
    }
    this._options = { ...options, agents: { ...options.agents } }
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

  /** 可直接交给 Hono、Node 适配器或其他 Fetch 宿主 */
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

  /** 结束 Engine 与订阅后才允许宿主关闭 Store；重复调用共享同一关闭结果 */
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
            try {
              await result.value.engine.close()
            }
            finally {
              result.value.events.close()
            }
          })()]
        : [])])
      throwSettledErrors(results, '关闭 Agent Server 失败')
    })
    return this._closing
  }

  private async _authorize(context: Context, path: readonly string[], input: unknown) {
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
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
    const workspace = await this._options.workspace({ ...target, signal: this._lifetime.signal })
    if (this._closed)
      throw new ORPCError('SERVICE_UNAVAILABLE')
    const owner = this._storeWorkspaces.get(workspace.store)
    if (owner !== undefined && owner !== target.workspaceId)
      throw new Error('同一 RuntimeStore 不能同时属于不同工作区')
    this._storeWorkspaces.set(workspace.store, target.workspaceId)
    const events = RuntimeEventHub.create({ maxBytes: this._options.eventBufferBytes })
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
    const engine = AgentEngine.create({ [agent.id]: agent }, {
      ...this._options.engine,
      restoreModel: config => Promise.resolve(this._options.model({ ...target, frozenConfig: config, signal: this._lifetime.signal })),
      onRuntimeEvent: (_agentId, event) => emit(event),
    })
    try {
      await engine.recoverWorkspace({
        agentId: agent.id,
        store: workspace.store,
        resolveThreadLocation: ({ id, dir }) => Promise.resolve(workspace.resolveLocation({ threadId: id, dir })),
      })
      return { target, workspace, agent, engine, events, emit }
    }
    catch (error) {
      try {
        await engine.close()
      }
      finally {
        events.close()
      }
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
    const location = await scope.workspace.resolveLocation({ threadId, dir: record?.dir })
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
      input: () => Promise.resolve(this._options.prepareInput
        ? this._options.prepareInput(input.input, { ...scope.target, threadId: input.threadId, location, store: scope.workspace.store })
        : input.input.map((part): TurnInputPart => {
            if (part.type === 'document')
              throw new ORPCError('BAD_REQUEST', { message: '文档输入需要宿主提供 prepareInput' })
            return part
          })),
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
