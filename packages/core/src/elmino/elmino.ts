import type { Agent } from '@elmino/agent'
import type { RunAgentResult, TurnExecution, TurnInputPart } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { RuntimeStore, RuntimeStoreLease, RuntimeThreadRecord } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread/events'
import type {
  CreateTurnInput,
  ElminoObserver,
  ElminoOptions,
  InterruptTurnInput,
  ListThreadsInput,
  ModelRequest,
  ResumeTurnInput,
  RunInput,
  SteerTurnInput,
  ThreadTarget,
  Workspace,
  WorkspaceTarget,
} from './types'
import path from 'node:path'
import { AgentEngine } from '@elmino/engine'
import { createId, deepEqual, throwSettledErrors } from '@elmino/shared'
import { isPathWithin } from '@elmino/shared/node'
import {
  hydrateThreadMessages,
  readThreadSnapshot,
  readThreadUsage,
  runtimeRecordsToThreadListItem,
} from '@elmino/thread'
import { ElminoError } from './error'

/** 一个 Agent / 工作区的执行资源，只由 Elmino 持有 */
interface Scope {
  /** 固定资源归属 */
  target: WorkspaceTarget
  /** 存储和位置由宿主或配置提供 */
  workspace: Workspace
  /** Elmino 借用的存储，在执行与观察结束后释放 */
  lease?: RuntimeStoreLease
  /** 已注册的执行定义 */
  agent: Agent
  /** 此作用域唯一的执行引擎 */
  engine: AgentEngine
  /** 本地执行、后台任务和 Server 共用的事实出口 */
  emit: (event: RuntimeEvent) => Promise<void>
}

/** 应用实例拥有执行生命周期，Server 只借用此实例 */
export class Elmino {
  private readonly _options: ElminoOptions
  private readonly _scopes = new Map<string, Promise<Scope>>()
  private readonly _storeWorkspaces = new WeakMap<RuntimeStore, string>()
  private readonly _pending = new Set<Promise<unknown>>()
  private readonly _observers = new Set<ElminoObserver>()
  private readonly _lifetime = new AbortController()
  private _closed = false
  private _closing?: Promise<void>

  /** 定义时捕获配置，不创建模型连接、Engine 或存储租约 */
  private constructor(options: ElminoOptions) {
    for (const [key, agent] of Object.entries(options.agents)) {
      if (key !== agent.id)
        throw new TypeError('Agent 注册键必须与定义中的 id 一致')
    }
    if (typeof options.workspace !== 'function' && !options.workspace.id.trim())
      throw new TypeError('工作区 id 不能为空')
    this._options = {
      ...options,
      agents: { ...options.agents },
      models: typeof options.models === 'function' ? options.models : { ...options.models },
      defaults: options.defaults ? { ...options.defaults } : undefined,
      workspace: typeof options.workspace === 'function'
        ? options.workspace
        : { ...options.workspace, rootDir: path.resolve(options.workspace.rootDir) },
    }
  }

  /** 创建实例；实际资源按作用域首次使用时加载 */
  public static create(options: ElminoOptions): Elmino {
    return new Elmino(options)
  }

  /** 关闭开始后拒绝新的执行与资源解析 */
  public get closed(): boolean {
    return this._closed
  }

  /** 获取注册的 Agent 定义，不隐式打开工作区 */
  public getAgent(id: string): Agent {
    const agent = Object.hasOwn(this._options.agents, id) ? this._options.agents[id] : undefined
    if (!agent)
      throw new ElminoError('NOT_FOUND', 'Agent 不存在')
    return agent
  }

  /** 列出已注册的定义，调用方不会得到可修改的注册表 */
  public listAgents(): Agent[] {
    return Object.values(this._options.agents)
  }

  /** 观察器不拥有执行；取消只移除该观察器 */
  public subscribe(observer: ElminoObserver): () => void {
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    this._observers.add(observer)
    return () => {
      this._observers.delete(observer)
    }
  }

  /** 提前恢复一个工作区，也可由事件接入方在订阅前调用 */
  public openWorkspace(target: WorkspaceTarget): Promise<void> {
    return this._track(async () => {
      await this._scope(target)
    })
  }

  /** 读取持久线程列表，不依赖 HTTP 请求 */
  public listThreads(input: ListThreadsInput) {
    return this._track(async () => this._list(await this._scope(input), input))
  }

  /** 读取持久消息与当前流式内容的统一线程状态 */
  public getThread(input: ThreadTarget) {
    return this._track(async () => this._state(await this._scope(input), input.threadId))
  }

  /** 接纳后返回线程状态，模型和工具继续由共享 Engine 执行 */
  public createTurn(input: CreateTurnInput) {
    return this._track(async () => {
      const scope = await this._scope(input)
      return this._accept(scope, input, await this._execute(scope, input))
    })
  }

  /** 按原中断与冻结配置恢复，不能覆盖模型或执行权限 */
  public resumeTurn(input: ResumeTurnInput) {
    return this._track(async () => this._resume(await this._scope(input), input))
  }

  /** 中断准确的活跃执行，并等持久事实完成结算 */
  public interruptTurn(input: InterruptTurnInput) {
    return this._track(async () => this._interrupt(await this._scope(input), input))
  }

  /** 在执行边界消费补充要求，不重启模型或工具 */
  public steerTurn(input: SteerTurnInput) {
    return this._track(async () => this._steer(await this._scope(input), input))
  }

  /** 无需 Server，直接在应用实例中运行并等待本轮完成 */
  public run(input: RunInput): Promise<RunAgentResult> {
    return this._track(async () => {
      const definition = this._options.workspace
      const workspaceId = input.workspaceId ?? (typeof definition === 'function' ? undefined : definition.id)
      if (!workspaceId)
        throw new ElminoError('BAD_REQUEST', '动态工作区需要提供 workspaceId')
      const request: CreateTurnInput = {
        ...input,
        workspaceId,
        threadId: input.threadId ?? createId('thread'),
        turnId: input.turnId ?? createId('turn'),
        input: typeof input.input === 'string' ? [{ type: 'text', text: input.input }] : input.input,
      }
      const scope = await this._scope(request)
      const execution = await this._execute(scope, request)
      await this._accepted(execution)
      const message = await execution.completed
      const turn = await scope.workspace.store.turns.read(request.turnId)
      if (!turn)
        throw new Error('Agent 执行结束后缺少持久化 Turn')
      const errorMessage = turn.errorMessage ?? undefined
      return { threadId: request.threadId, turnId: request.turnId, workspaceId, status: turn.status, errorMessage, message }
    })
  }

  /** 结算执行和入口，结束观察，最后释放配置租约；外部 Store 仍由宿主关闭 */
  public close(): Promise<void> {
    if (this._closing)
      return this._closing
    this._closed = true
    this._closing = Promise.resolve().then(async () => {
      this._lifetime.abort()
      const settled = await Promise.allSettled(this._scopes.values())
      const scopes = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      const results = await Promise.allSettled([
        ...this._pending,
        ...scopes.map(scope => scope.engine.close()),
      ])
      // 入口的拒绝已交给调用方；关闭只报告清理失败，不重复传播正常的取消结果
      const cleanup = results.slice(results.length - scopes.length)
      cleanup.push(...await Promise.allSettled([...this._observers].map(async (observer) => {
        await observer.onClose?.()
      })))
      this._observers.clear()
      cleanup.push(...await Promise.allSettled(scopes.map(async (scope) => {
        await scope.lease?.release()
      })))
      throwSettledErrors(cleanup, '关闭 Elmino 资源失败')
    })
    return this._closing
  }

  private _track<T>(operation: () => Promise<T>): Promise<T> {
    if (this._closed)
      return Promise.reject(new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭'))
    const task = operation()
    this._pending.add(task)
    task.finally(() => this._pending.delete(task)).catch(() => undefined)
    return task
  }

  private async _scope(input: WorkspaceTarget): Promise<Scope> {
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    const target = { agentId: input.agentId, workspaceId: input.workspaceId }
    const key = JSON.stringify([target.agentId, target.workspaceId])
    let pending = this._scopes.get(key)
    if (!pending) {
      pending = this._createScope(target)
      this._scopes.set(key, pending)
      pending.catch(() => {
        if (this._scopes.get(key) === pending)
          this._scopes.delete(key)
      })
    }
    const scope = await pending
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    return scope
  }

  private async _model(input: ModelRequest): Promise<TurnModel<ModelTurnConfig>> {
    const models = this._options.models
    const modelId = input.frozenConfig
      ? typeof input.frozenConfig.id === 'string' ? input.frozenConfig.id : undefined
      : input.modelId ?? this.getAgent(input.agentId).model ?? this._options.defaults?.model
    if (typeof models === 'function')
      return models({ ...input, modelId })
    const key = modelId ?? (Object.keys(models).length === 1 ? Object.keys(models)[0] : undefined)
    const source = key && Object.hasOwn(models, key) ? models[key] : undefined
    if (!source)
      throw new ElminoError('NOT_FOUND', '模型未注册或缺少默认模型')
    const model = typeof source === 'function' ? await source({ ...input, modelId: key }) : source
    if (model.config.id !== key)
      throw new ElminoError('BAD_REQUEST', '模型配置 id 必须与注册键一致')
    if (input.frozenConfig && !deepEqual(model.config, input.frozenConfig))
      throw new ElminoError('CONFLICT', '恢复模型必须沿用原 Turn 的冻结配置')
    return model
  }

  private async _createScope(target: WorkspaceTarget): Promise<Scope> {
    const agent = this.getAgent(target.agentId)
    const definition = this._options.workspace
    let lease: RuntimeStoreLease | undefined
    let engine: AgentEngine | undefined
    try {
      let workspace: Workspace
      if (typeof definition === 'function') {
        workspace = await definition({ ...target, signal: this._lifetime.signal })
      }
      else {
        if (target.workspaceId !== definition.id)
          throw new ElminoError('NOT_FOUND', '工作区不存在')
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
        throw new ElminoError('SERVICE_UNAVAILABLE')
      const owner = this._storeWorkspaces.get(workspace.store)
      if (owner !== undefined && owner !== target.workspaceId)
        throw new Error('同一 RuntimeStore 不能同时属于不同工作区')
      this._storeWorkspaces.set(workspace.store, target.workspaceId)
      /** 所有执行入口都使用同一个发布出口 */
      const emit = async (event: RuntimeEvent) => {
        try {
          for (const observer of this._observers) {
            try {
              await observer.onEvent(target, event)
            }
            catch (error) {
              await this._report(error)
            }
          }
          await this._options.onEvent?.(target, event)
        }
        catch (error) {
          await this._report(error)
        }
      }
      engine = AgentEngine.create({ [agent.id]: agent }, {
        ...this._options.engine,
        restoreModel: config => this._model({ ...target, frozenConfig: config, signal: this._lifetime.signal }),
        onRuntimeEvent: (_agentId, event) => emit(event),
      })
      await engine.recoverWorkspace({
        agentId: agent.id,
        store: workspace.store,
        threadLocation: ({ id, dir }) => workspace.location({ threadId: id, dir }),
      })
      return { target, workspace, agent, engine, emit, lease }
    }
    catch (error) {
      const cleanup = await Promise.allSettled([(async () => {
        await engine?.close()
      })()])
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
      throw new ElminoError('NOT_FOUND', '线程不存在')
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
      throw new ElminoError('NOT_FOUND')
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

  private async _list(scope: Scope, input: ListThreadsInput) {
    const { store } = scope.workspace
    const page = await store.threads.page({ agentId: input.agentId, archived: input.archived ?? false, limit: input.limit ?? 50 })
    // 一个 RuntimeStore 属于一个工作区，按当前作用域过滤所有返回记录
    const records = page.items.filter(record => record.metadata.workspaceId === input.workspaceId)
    const latest = await store.turns.latest(records.map(record => record.id))
    const byId = new Map(latest.map(turn => [turn.threadId, turn]))
    return { items: records.map(record => runtimeRecordsToThreadListItem(record, byId.get(record.id))), hasMore: page.hasMore }
  }

  private async _execute(scope: Scope, input: CreateTurnInput): Promise<TurnExecution> {
    const record = await this._thread(scope, input.threadId, true)
    const location = await this._location(scope, input.threadId, record)
    const signal = input.signal ? AbortSignal.any([input.signal, this._lifetime.signal]) : this._lifetime.signal
    signal.throwIfAborted()
    const model = await this._model({ ...scope.target, modelId: input.modelId ?? record?.settings.modelId, signal })
    return scope.engine.run({
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
            throw new ElminoError('BAD_REQUEST', '文档输入需要宿主提供 prepareInput')
          return part
        })
      },
      onRuntimeEvent: scope.emit,
      approvalMode: input.approvalMode ?? this._options.defaults?.approvalMode,
      subagentMode: input.subagentMode ?? this._options.defaults?.subagentMode,
      signal: input.signal,
    }, scope.workspace.store)
  }

  private async _resume(scope: Scope, input: ResumeTurnInput) {
    const record = (await this._thread(scope, input.threadId))!
    const turn = await scope.workspace.store.turns.read(input.turnId)
    if (!turn || turn.threadId !== input.threadId || turn.agentSnapshot.id !== input.agentId)
      throw new ElminoError('NOT_FOUND', 'Turn 不存在')
    if (turn.status !== 'interrupted' || turn.interrupt?.id !== input.interruptId)
      throw new ElminoError('CONFLICT', '当前中断已失效或不可恢复')
    const location = await this._location(scope, input.threadId, record)
    const model = await this._model({ ...scope.target, frozenConfig: turn.modelConfig, signal: this._lifetime.signal })
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

  private async _accepted(execution: TurnExecution) {
    execution.completed.catch(error => this._report(error))
    try {
      await execution.accepted
    }
    catch (cause) {
      if (cause instanceof ElminoError)
        throw cause
      throw new ElminoError('CONFLICT', cause instanceof Error ? cause.message : '任务未被接纳', { cause })
    }
  }

  private async _accept(scope: Scope, input: ThreadTarget, execution: TurnExecution) {
    await this._accepted(execution)
    return this._state(scope, input.threadId)
  }

  private async _interrupt(scope: Scope, input: InterruptTurnInput) {
    await this._thread(scope, input.threadId)
    await scope.engine.interrupt({ ...input, store: scope.workspace.store })
    return this._state(scope, input.threadId)
  }

  private async _steer(scope: Scope, input: SteerTurnInput) {
    await this._thread(scope, input.threadId)
    try {
      return await scope.engine.steer({ ...input, store: scope.workspace.store })
    }
    catch (cause) {
      throw new ElminoError('CONFLICT', cause instanceof Error ? cause.message : '当前任务无法接收引导', { cause })
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

/** 定义应用实例，能力可本地使用，也可交给一个或多个 Server */
export function defineElmino(options: ElminoOptions): Elmino {
  return Elmino.create(options)
}
