import type { Agent } from '@elmino/agent'
import type { RunAgentResult, TurnExecution, TurnInputPart } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { RuntimeStore, RuntimeStoreLease, RuntimeThreadRecord } from '@elmino/store'
import type { ThreadTranscriptPage, ThreadTurnRecord } from '@elmino/thread'
import type { RuntimeEvent } from '@elmino/thread/events'
import type {
  CancelTurnInput,
  CreateTurnInput,
  ElminoObserver,
  ElminoOptions,
  InterruptTurnInput,
  ListThreadsInput,
  ModelRequest,
  ReadTranscriptInput,
  ResumeTurnInput,
  RunInput,
  SteerTurnInput,
  ThreadTarget,
  Workspace,
  WorkspaceTarget,
} from './types'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { AgentEngine } from '@elmino/engine'
import { createId, deepEqual, isPlainRecord, throwSettledErrors } from '@elmino/shared'
import { isPathWithin } from '@elmino/shared/node'
import {
  hydrateThreadMessages,
  projectThreadTurnRecords,
  projectThreadTurnState,
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
  /** 定义时复制的宿主配置，不随外部注册表后续变更 */
  private readonly _options: ElminoOptions
  /** 按 Agent 和工作区缓存初始化中的 Promise，合并并发资源申请 */
  private readonly _scopes = new Map<string, Promise<Scope>>()
  /** 记录 Store 的工作区归属，防止同一实例混用不同工作区 */
  private readonly _storeWorkspaces = new WeakMap<RuntimeStore, string>()
  /** 已接纳但尚未退出的入口调用，关闭时先等待这些操作结算 */
  private readonly _pending = new Set<Promise<unknown>>()
  /** 借用应用事实出口的观察方，不拥有 Engine 或存储 */
  private readonly _observers = new Set<ElminoObserver>()
  /** 应用关闭时取消资源初始化与模型解析的统一信号 */
  private readonly _lifetime = new AbortController()
  /** 关闭开始即拒绝新入口，避免清理期间重新打开资源 */
  private _closed = false
  /** 唯一关闭任务，重复关闭共享同一次资源释放结果 */
  private _closing?: Promise<void>

  /**
   * 定义时捕获配置，不创建模型连接、Engine 或存储租约
   */
  private constructor(options: ElminoOptions) {
    // 注册键与定义身份必须一致，避免共享资源按另一身份打开
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

  /**
   * 创建实例；实际资源按作用域首次使用时加载
   */
  public static create(options: ElminoOptions): Elmino {
    return new Elmino(options)
  }

  /**
   * 关闭开始后拒绝新的执行与资源解析
   */
  public get closed(): boolean {
    return this._closed
  }

  /**
   * 获取注册的 Agent 定义，不隐式打开工作区
   */
  public getAgent(id: string): Agent {
    // 只读取自身注册项，避免原型属性被当作 Agent 定义
    const agent = Object.hasOwn(this._options.agents, id) ? this._options.agents[id] : undefined
    if (!agent)
      throw new ElminoError('NOT_FOUND', 'Agent 不存在')
    return agent
  }

  /**
   * 列出已注册的定义，调用方不会得到可修改的注册表
   */
  public listAgents(): Agent[] {
    return Object.values(this._options.agents)
  }

  /**
   * 观察器不拥有执行；取消只移除该观察器
   */
  public subscribe(observer: ElminoObserver): () => void {
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    this._observers.add(observer)
    return () => {
      this._observers.delete(observer)
    }
  }

  /**
   * 提前恢复一个工作区，也可由事件接入方在订阅前调用
   */
  public openWorkspace(target: WorkspaceTarget): Promise<void> {
    return this._track(async () => {
      await this._scope(target)
    })
  }

  /**
   * 读取持久线程列表，不依赖 HTTP 请求
   */
  public listThreads(input: ListThreadsInput) {
    return this._track(async () => this._list(await this._scope(input), input))
  }

  /**
   * 读取持久消息与当前流式内容的统一线程状态
   */
  public getThread(input: ThreadTarget) {
    return this._track(async () => this._state(await this._scope(input), input.threadId))
  }

  /**
   * 查询持久化运行记录，重启后仍保留冻结身份、失败原因与待处理交互
   */
  public listTurns(input: ThreadTarget): Promise<ThreadTurnRecord[]> {
    return this._track(async () => {
      // 先确认归属，任何历史查询都不能读取其他 Agent 或工作区的数据
      const scope = await this._scope(input)
      await this._thread(scope, input.threadId)
      const { store } = scope.workspace
      // 历史记录来自 Store，活动消息只校准当前进程尚在输出的正文
      const [turns, storedMessages] = await Promise.all([
        store.turns.list(input.threadId),
        hydrateThreadMessages({ store, threadId: input.threadId }),
      ])
      const messages = scope.engine.mergeThreadMessages(input.threadId, storedMessages)
      return projectThreadTurnRecords({ turns, messages })
    })
  }

  /**
   * 按完整运行边界读取一页转录，历史页不混入当前进程的流式消息
   */
  public readTranscript(input: ReadTranscriptInput): Promise<ThreadTranscriptPage> {
    return this._track(async () => {
      // 1. 确认线程归属后才解释游标和读取持久化内容
      const scope = await this._scope(input)
      await this._thread(scope, input.threadId)
      const { store } = scope.workspace
      const limit = input.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new ElminoError('BAD_REQUEST', '历史页大小必须在 1 到 50 之间')
      // 游标绑定完整归属，不能用另一线程或工作区的分页位置读取当前历史
      let cursor: { createdAt: string, id: string } | undefined
      if (input.cursor) {
        try {
          const decoded: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
          if (!isPlainRecord(decoded) || decoded.agentId !== input.agentId
            || decoded.workspaceId !== input.workspaceId || decoded.threadId !== input.threadId
            || typeof decoded.id !== 'string' || !decoded.id.startsWith('turn_')
            || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt))) {
            throw new Error('历史游标不属于当前线程')
          }
          cursor = { createdAt: decoded.createdAt, id: decoded.id }
        }
        catch (cause) {
          throw new ElminoError('BAD_REQUEST', '对话历史游标无效', { cause })
        }
      }
      // 2. Store 负责稳定的创建时间和 ID 排序，消息按页内 Turn 范围读取
      const page = await store.turns.page({ threadId: input.threadId, cursor, limit })
      const turnIds = page.turns.map(turn => turn.id)
      const storedMessages = await hydrateThreadMessages({ store, threadId: input.threadId, turnIds })
      const projectedMessages = cursor ? storedMessages : scope.engine.mergeThreadMessages(input.threadId, storedMessages)
      const messagesByTurn = Map.groupBy(projectedMessages, message => message.turnId)
      // 只保留本页 Turn 的完整消息，当前运行的其他消息不能泄漏到历史页
      const messages = turnIds.flatMap(turnId => messagesByTurn.get(turnId) ?? [])
      const turns = page.turns.map(projectThreadTurnState)
      // 3. 返回不透明的更早历史位置，不让客户端依赖存储层游标字段
      const nextCursor = page.nextCursor
        ? Buffer.from(JSON.stringify({
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            ...page.nextCursor,
          })).toString('base64url')
        : null
      return { turns, messages, nextCursor }
    })
  }

  /**
   * 接纳后返回线程状态，模型和工具继续由共享 Engine 执行
   */
  public createTurn(input: CreateTurnInput) {
    return this._track(async () => {
      // 同一工作区内的创建、控制与查询借用同一组执行资源
      const scope = await this._scope(input)
      return this._accept(scope, input, await this._execute(scope, input))
    })
  }

  /**
   * 按原中断与冻结配置恢复，不能覆盖模型或执行权限
   */
  public resumeTurn(input: ResumeTurnInput) {
    return this._track(async () => this._resume(await this._scope(input), input))
  }

  /**
   * 取消当前待处理交互，保持原运行的终态与工具结算一致
   */
  public cancelTurn(input: CancelTurnInput) {
    return this._track(async () => {
      // 取消只能访问当前 Agent 与工作区所属的持久化记录
      const scope = await this._scope(input)
      await this._thread(scope, input.threadId)
      // 只有原交互在事务内仍待处理，Engine 才报告取消成功
      let cancelled: boolean
      try {
        cancelled = await scope.engine.cancelInteraction({ ...input, store: scope.workspace.store })
      }
      catch (cause) {
        throw new ElminoError('CONFLICT', cause instanceof Error ? cause.message : '当前交互无法取消', { cause })
      }
      if (!cancelled)
        throw new ElminoError('CONFLICT', '当前交互已失效或不可取消')
      return this._state(scope, input.threadId)
    })
  }

  /**
   * 中断准确的活跃执行，并等持久事实完成结算
   */
  public interruptTurn(input: InterruptTurnInput) {
    return this._track(async () => this._interrupt(await this._scope(input), input))
  }

  /**
   * 在执行边界消费补充要求，不重启模型或工具
   */
  public steerTurn(input: SteerTurnInput) {
    return this._track(async () => this._steer(await this._scope(input), input))
  }

  /**
   * 无需 Server，直接在应用实例中运行并等待本轮完成
   */
  public run(input: RunInput): Promise<RunAgentResult> {
    return this._track(async () => {
      // 静态工作区可以补足身份，动态提供方要求调用者明确指定
      const definition = this._options.workspace
      // 本次调用固定的工作区键，后续模型解析和执行共用
      const workspaceId = input.workspaceId ?? (typeof definition === 'function' ? undefined : definition.id)
      if (!workspaceId)
        throw new ElminoError('BAD_REQUEST', '动态工作区需要提供 workspaceId')
      // 本地运行也使用统一创建输入，并在提交前固定线程与 Turn 身份
      const request: CreateTurnInput = {
        ...input,
        workspaceId,
        threadId: input.threadId ?? createId('thread'),
        turnId: input.turnId ?? createId('turn'),
        input: typeof input.input === 'string' ? [{ type: 'text', text: input.input }] : input.input,
      }
      // 本轮借用的资源由应用持有，运行结束不关闭共享 Engine
      const scope = await this._scope(request)
      // 接纳与完成分开等待，以便及时暴露提交阶段的冲突
      const execution = await this._execute(scope, request)
      await this._accepted(execution)
      // 执行器返回的本轮助手回复，可能在交互中断时缺省
      const message = await execution.completed
      // 终态以持久化 Turn 为准，不从回复是否存在推断成功
      const turn = await scope.workspace.store.turns.read(request.turnId)
      if (!turn)
        throw new Error('Agent 执行结束后缺少持久化 Turn')
      // 对外结果使用可选错误字段，存储中的 null 不泄漏到调用契约
      const errorMessage = turn.errorMessage ?? undefined
      return { threadId: request.threadId, turnId: request.turnId, workspaceId, status: turn.status, errorMessage, message }
    })
  }

  /**
   * 结算执行和入口，结束观察，最后释放配置租约；外部 Store 仍由宿主关闭
   */
  public close(): Promise<void> {
    if (this._closing)
      return this._closing
    this._closed = true
    this._closing = Promise.resolve().then(async () => {
      this._lifetime.abort()
      // 等初始化退出后才能确定本实例实际取得了哪些资源
      const settled = await Promise.allSettled(this._scopes.values())
      // 初始化失败的作用域由创建路径自行清理，只关闭成功取得的资源
      const scopes = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      // 入口调用与 Engine 关闭同时收口，避免遗漏已接纳的后台执行
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

  /**
   * 拒绝关闭后的新调用，并跟踪入口任务直到退出，供关闭流程统一等待
   */
  private _track<T>(operation: () => Promise<T>): Promise<T> {
    if (this._closed)
      return Promise.reject(new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭'))
    // 保留原 Promise 的成功或失败结果，跟踪只负责生命周期清理
    const task = operation()
    this._pending.add(task)
    task.finally(() => this._pending.delete(task)).catch(() => undefined)
    return task
  }

  /**
   * 按 Agent 与工作区延迟创建共享资源；并发复用初始化，失败后允许重试
   */
  private async _scope(input: WorkspaceTarget): Promise<Scope> {
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    // 1. 只保存资源身份，不让某次请求的额外字段进入共享作用域
    const target = { agentId: input.agentId, workspaceId: input.workspaceId }
    // 组合键避免不同 Agent 或工作区之间共享初始化任务
    const key = JSON.stringify([target.agentId, target.workspaceId])
    // 2. 缓存初始化 Promise，资源尚未打开时也合并并发请求
    let pending = this._scopes.get(key)
    if (!pending) {
      pending = this._createScope(target)
      this._scopes.set(key, pending)
      pending.catch(() => {
        if (this._scopes.get(key) === pending)
          this._scopes.delete(key)
      })
    }
    // 3. 等待后再检查关闭状态，避免把清理中的资源交给调用者
    const scope = await pending
    if (this._closed)
      throw new ElminoError('SERVICE_UNAVAILABLE', 'Elmino 已关闭')
    return scope
  }

  /**
   * 选择注册模型或调用宿主提供方；恢复时严格保持原 Turn 的冻结配置
   */
  private async _model(input: ModelRequest): Promise<TurnModel<ModelTurnConfig>> {
    // 宿主可以提供静态注册表，也可以按请求动态创建模型
    const models = this._options.models
    // 冻结配置优先于当前默认值，普通运行依次使用请求、Agent 与应用默认值
    const modelId = input.frozenConfig
      ? typeof input.frozenConfig.id === 'string' ? input.frozenConfig.id : undefined
      : input.modelId ?? this.getAgent(input.agentId).model ?? this._options.defaults?.model
    if (typeof models === 'function')
      return models({ ...input, modelId })
    // 只有唯一注册模型时允许省略默认键，避免静默选择另一家模型
    const key = modelId ?? (Object.keys(models).length === 1 ? Object.keys(models)[0] : undefined)
    // 自身属性限定模型注册边界，缺失项交由统一错误路径处理
    const source = key && Object.hasOwn(models, key) ? models[key] : undefined
    if (!source)
      throw new ElminoError('NOT_FOUND', '模型未注册或缺少默认模型')
    // 工厂与现成实例最终都必须满足注册身份和冻结配置约束
    const model = typeof source === 'function' ? await source({ ...input, modelId: key }) : source
    if (model.config.id !== key)
      throw new ElminoError('BAD_REQUEST', '模型配置 id 必须与注册键一致')
    if (input.frozenConfig && !deepEqual(model.config, input.frozenConfig))
      throw new ElminoError('CONFLICT', '恢复模型必须沿用原 Turn 的冻结配置')
    return model
  }

  /**
   * 打开存储与 Engine 并恢复工作区；装配失败按顺序释放已取得的资源
   */
  private async _createScope(target: WorkspaceTarget): Promise<Scope> {
    // 在申请存储前确认 Agent 已注册，未知身份不应打开执行资源
    const agent = this.getAgent(target.agentId)
    // 定义时捕获的静态工作区或动态工作区提供方
    const definition = this._options.workspace
    // 仅配置工厂取得的 Store 租约由本实例负责释放
    let lease: RuntimeStoreLease | undefined
    // 保留已创建的 Engine，后续恢复失败时仍能先终止执行再释放存储
    let engine: AgentEngine | undefined
    try {
      // 1. 静态配置与动态提供方统一为存储加线程位置能力
      let workspace: Workspace
      if (typeof definition === 'function') {
        workspace = await definition({ ...target, signal: this._lifetime.signal })
      }
      else {
        if (target.workspaceId !== definition.id)
          throw new ElminoError('NOT_FOUND', '工作区不存在')
        // Store 可以是宿主持有的实例，也可以是可引用计数的延迟租约工厂
        const source = definition.store
        // 选定的存储贯穿此作用域，不随单次 Turn 重新创建
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
          /** 基于固定工作区和线程相对目录生成执行位置 */
          location: ({ dir = '.' }) => {
            // 将线程相对目录锚定工作区根目录，再校验目录边界
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
      // 2. 同一 Store 可以供多个 Agent 借用，但不能混入不同工作区的数据
      const owner = this._storeWorkspaces.get(workspace.store)
      if (owner !== undefined && owner !== target.workspaceId)
        throw new Error('同一 RuntimeStore 不能同时属于不同工作区')
      this._storeWorkspaces.set(workspace.store, target.workspaceId)
      // 3. 所有执行入口使用同一事实出口，逐个隔离观察失败
      /** 向工作区观察方和宿主发布领域事实，不转移执行所有权 */
      const emit = async (event: RuntimeEvent) => {
        try {
          // 按当前订阅顺序通知，单个观察器失败不跳过后续观察方
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
      // 4. 先绑定恢复和事件能力，再从持久事实恢复此工作区
      engine = AgentEngine.create({ [agent.id]: agent }, {
        ...this._options.engine,
        /** 通过相同模型提供方校验并恢复原 Turn 的冻结模型 */
        restoreModel: config => this._model({ ...target, frozenConfig: config, signal: this._lifetime.signal }),
        /** 将引擎事实转入当前工作区唯一发布出口 */
        onRuntimeEvent: (_agentId, event) => emit(event),
      })
      await engine.recoverWorkspace({
        agentId: agent.id,
        store: workspace.store,
        /** 重启恢复沿用线程持久化目录，不为恢复重新分配位置 */
        threadLocation: ({ id, dir }) => workspace.location({ threadId: id, dir }),
      })
      return { target, workspace, agent, engine, emit, lease }
    }
    catch (error) {
      // 5. 装配失败先等待 Engine 停止，再释放租约，避免执行访问已关闭存储
      const cleanup = await Promise.allSettled([(async () => {
        await engine?.close()
      })()])
      cleanup.push(...await Promise.allSettled([(async () => {
        await lease?.release()
      })()]))
      // 装配原始错误返回调用方，清理错误额外交给宿主观察
      const errors = cleanup.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length > 0)
        await this._report(new AggregateError([error, ...errors], '打开工作区和资源关闭均失败'))
      throw error
    }
  }

  /**
   * 校验线程归属及有效状态；新建入口可显式允许记录尚不存在
   */
  private async _thread(scope: Scope, threadId: string, optional = false) {
    // 持久化记录提供 Agent、工作区及删除状态的权威归属
    const record = await scope.workspace.store.threads.read(threadId)
    if (!record && optional)
      return
    if (!record || record.agentId !== scope.target.agentId || record.metadata.workspaceId !== scope.target.workspaceId
      || record.lifecycle !== 'active') {
      throw new ElminoError('NOT_FOUND', '线程不存在')
    }
    return record
  }

  /**
   * 读取线程执行位置，并保证宿主返回值与持久化工作区和目录一致
   */
  private async _location(scope: Scope, threadId: string, record?: RuntimeThreadRecord) {
    // 已存在的线程沿用原相对目录，不能因宿主配置变化悄悄切换位置
    const location = await scope.workspace.location({ threadId, dir: record?.dir })
    if (location.workspaceId !== scope.target.workspaceId || (record && location.dir !== record.dir))
      throw new Error('宿主返回的位置与线程工作区或持久化目录不一致')
    return location
  }

  /**
   * 汇总持久化历史、子任务和实时正文，生成不依赖 HTTP 的完整线程状态
   */
  private async _state(scope: Scope, threadId: string) {
    // 1. 先确认归属与位置，避免读取其他 Agent 或工作区的线程内容
    const record = (await this._thread(scope, threadId))!
    // 本次状态汇总统一从作用域固定的事实存储读取
    const { store } = scope.workspace
    // 线程位置参与持久化快照恢复，必须先通过宿主一致性校验
    const location = await this._location(scope, threadId, record)
    // 2. 并行读取领域投影需要的历史、运行时间线、子任务及用量
    const [snapshot, messages, turns, children, usage] = await Promise.all([
      readThreadSnapshot(store, threadId, location),
      hydrateThreadMessages({ store, threadId }),
      store.turns.list(threadId),
      scope.engine.listChildren({ agentId: scope.agent.id, parentThreadId: threadId, store }),
      readThreadUsage(store, threadId),
    ])
    if (!snapshot)
      throw new ElminoError('NOT_FOUND')
    // 3. 由线程领域生成状态，运行中正文用 Engine 的更新内容校准
    return scope.agent.thread.toState(snapshot, {
      messages: scope.engine.mergeThreadMessages(threadId, messages),
      turns: turns.map(projectThreadTurnState),
      children,
      taskUsage: usage.taskUsage,
    })
  }

  /**
   * 查询当前工作区的线程前缀列表，并补充各线程最新运行状态
   */
  private async _list(scope: Scope, input: ListThreadsInput) {
    // 列表与最新 Turn 查询共用当前作用域的存储
    const { store } = scope.workspace
    // 数量限制由入口契约约束，这里只应用归档筛选与默认数量
    const page = await store.threads.page({ agentId: input.agentId, archived: input.archived ?? false, limit: input.limit ?? 50 })
    // 一个 RuntimeStore 属于一个工作区，按当前作用域过滤所有返回记录
    const records = page.items.filter(record => record.metadata.workspaceId === input.workspaceId)
    // 一次读取返回线程的最新 Turn，避免逐项查询
    const latest = await store.turns.latest(records.map(record => record.id))
    // 按线程匹配最新运行，列表项仍由线程领域负责投影
    const byId = new Map(latest.map(turn => [turn.threadId, turn]))
    return { items: records.map(record => runtimeRecordsToThreadListItem(record, byId.get(record.id))), hasMore: page.hasMore }
  }

  /**
   * 装配新 Turn 的位置、模型和输入，交给共享 Engine 接纳并执行
   */
  private async _execute(scope: Scope, input: CreateTurnInput): Promise<TurnExecution> {
    // 首轮允许线程尚未存在；追问则沿用持久化设置和目录
    const record = await this._thread(scope, input.threadId, true)
    // 模型和输入准备使用已校验的线程执行位置
    const location = await this._location(scope, input.threadId, record)
    // 模型解析同时响应调用方取消与应用关闭
    const signal = input.signal ? AbortSignal.any([input.signal, this._lifetime.signal]) : this._lifetime.signal
    signal.throwIfAborted()
    // 请求指定模型优先于线程设置，其余默认选择由模型提供方统一处理
    const model = await this._model({ ...scope.target, modelId: input.modelId ?? record?.settings.modelId, signal })
    return scope.engine.run({
      agentId: input.agentId,
      threadId: input.threadId,
      turnId: input.turnId,
      model,
      location,
      /** 在执行准备阶段完成宿主输入转换，不在 SDK 中复制附件处理 */
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

  /**
   * 校验原交互与冻结配置，恢复同一个 Turn，并返回接纳后的线程快照
   */
  private async _resume(scope: Scope, input: ResumeTurnInput) {
    // 恢复只作用于现有且归属一致的线程
    const record = (await this._thread(scope, input.threadId))!
    // 从原 Turn 读取中断与模型配置，不采用线程当前默认值
    const turn = await scope.workspace.store.turns.read(input.turnId)
    if (!turn || turn.threadId !== input.threadId || turn.agentSnapshot.id !== input.agentId)
      throw new ElminoError('NOT_FOUND', 'Turn 不存在')
    if (turn.status !== 'interrupted' || turn.interrupt?.id !== input.interruptId)
      throw new ElminoError('CONFLICT', '当前中断已失效或不可恢复')
    // 恢复沿用原线程目录，并重新校验宿主返回位置
    const location = await this._location(scope, input.threadId, record)
    // 冻结配置必须完整匹配，防止恢复到不同模型或参数
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

  /**
   * 等待执行接纳，将后台失败交给宿主观察，并把提交失败映射为应用冲突
   */
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

  /**
   * 接纳成功后读取权威快照；后续模型和工具继续由 Engine 管理
   */
  private async _accept(scope: Scope, input: ThreadTarget, execution: TurnExecution) {
    await this._accepted(execution)
    return this._state(scope, input.threadId)
  }

  /**
   * 中断准确的活跃 Turn，等待结算后返回线程的持久化状态
   */
  private async _interrupt(scope: Scope, input: InterruptTurnInput) {
    await this._thread(scope, input.threadId)
    await scope.engine.interrupt({ ...input, store: scope.workspace.store })
    return this._state(scope, input.threadId)
  }

  /**
   * 向准确的活跃 Turn 追加引导，不接纳时返回冲突而非另建运行
   */
  private async _steer(scope: Scope, input: SteerTurnInput) {
    await this._thread(scope, input.threadId)
    try {
      return await scope.engine.steer({ ...input, store: scope.workspace.store })
    }
    catch (cause) {
      throw new ElminoError('CONFLICT', cause instanceof Error ? cause.message : '当前任务无法接收引导', { cause })
    }
  }

  /**
   * 向宿主报告后台或清理失败，隔离错误观察器自身的异常
   */
  private async _report(error: unknown) {
    try {
      await this._options.onError?.(error)
    }
    catch {
      // 错误观察器不能制造未处理的 Promise 拒绝
    }
  }
}

/**
 * 定义应用实例，能力可本地使用，也可交给一个或多个 Server
 */
export function defineElmino(options: ElminoOptions): Elmino {
  return Elmino.create(options)
}
