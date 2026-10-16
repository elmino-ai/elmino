import type { ThreadInteractionInterrupt, ThreadState } from '@elmino/thread'
import type { ClientRun, ClientRunResult } from '../../src/run/types'
import type { ClientThread, ClientThreadSnapshot } from '../../src/thread/types'
import { createId } from '@elmino/shared'
import { DEFAULT_THREAD_SETTINGS } from '@elmino/store'
import { vi } from 'vitest'

/**
 * 创建独立的接纳与完成边界，测试能够准确安排两种响应的先后顺序
 */
export function createComposerRun(threadId: string) {
  // 两个完成器分别模拟服务端接纳与原运行结算
  const acceptance = Promise.withResolvers<void>()
  const completion = Promise.withResolvers<ClientRunResult>()
  // Composer 只消费运行的真实生命周期契约，不替身实现 Agent 循环
  const run: ClientRun = {
    agentId: 'writer',
    workspaceId: 'project',
    threadId,
    turnId: createId('turn'),
    accepted: acceptance.promise,
    completed: completion.promise,
    interrupt: vi.fn(),
    steer: vi.fn(),
    detach: vi.fn(),
  }
  return { run, acceptance, completion }
}

/**
 * 创建只模拟会话公开观察与发送边界的夹具，不启动网络或真实执行
 */
export function createComposerThread() {
  // 运行与会话状态共享同一个固定身份
  const threadId = createId('thread')
  // 没有由 Composer 启动的运行时，使用当前会话原本正在执行的稳定身份
  const externalTurnId = createId('turn')
  // Composer 读取完整会话中的运行摘要，其他字段不参与本组行为测试
  let snapshot: ClientThreadSnapshot = { status: 'connected' }
  // 会话订阅者集合可以直接核对组件与队列是否释放观察权
  const listeners = new Set<() => void>()
  // 每次发送由测试注入独立运行，避免固定 Promise 隐藏重入提交
  const runs: ReturnType<typeof createComposerRun>[] = []
  // 按真实公共方法接收结构化输入，便于断言队列内容和策略
  const start = vi.fn<ClientThread['start']>().mockImplementation(() => {
    // 新运行拥有独立的接纳与完成时机
    const next = createComposerRun(threadId)
    runs.push(next)
    return next.run
  })
  // 未消费的方法保留类型化 mock，确保新增必填契约不会被断言隐藏
  const thread: ClientThread = {
    agentId: 'writer',
    workspaceId: 'project',
    threadId,
    getSnapshot: () => snapshot,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    start,
    run: vi.fn<ClientThread['run']>(),
    attach: vi.fn<ClientThread['attach']>(),
    get: vi.fn<ClientThread['get']>(),
    listTurns: vi.fn<ClientThread['listTurns']>(),
    readTranscript: vi.fn<ClientThread['readTranscript']>(),
    watch: vi.fn<ClientThread['watch']>(),
    resume: vi.fn<ClientThread['resume']>(),
    approve: vi.fn<ClientThread['approve']>(),
    reject: vi.fn<ClientThread['reject']>(),
    respond: vi.fn<ClientThread['respond']>(),
    cancel: vi.fn<ClientThread['cancel']>(),
  }

  /** 更新唯一会话快照并通知当前订阅者 */
  const update = (patch: Partial<ClientThreadSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners])
      listener()
  }

  // 空会话保留真实公开字段，夹具不借断言掩盖缺失的领域数据
  const now = '2026-10-16T00:00:00.000Z'
  // 空会话没有任何模型用量，运行与任务使用同一份只读基线
  const usage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheWrite: 0,
    cacheRead: 0,
    estimated: 0,
    total: 0,
    cacheHitRate: 0,
  }

  /** 用完整空会话模拟运行与中断事实，不启动网络或模型 */
  const state = (status: ThreadState['runtime']['status'], pending = false): ThreadState => {
    // 本地完成结果和权威会话摘要使用同一个 Turn，不构造缺少所属运行的中断
    const turnId = runs.at(-1)?.run.turnId ?? externalTurnId
    // 中断同时属于运行摘要和当前 runtime，公开 Schema 会校验这两处归属
    const interrupt: ThreadInteractionInterrupt | undefined = pending
      ? {
          id: createId('interrupt'),
          turnId,
          kind: 'interaction',
          interaction: 'tool-approval',
          status: 'pending',
          reason: '等待用户审批',
          createdAt: now,
          resumableWith: ['interaction'],
          payload: {},
        }
      : undefined
    return {
      agentId: thread.agentId,
      workspaceId: thread.workspaceId,
      threadId,
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      pinned: false,
      unreadAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      lastInteractionAt: now,
      messages: [],
      turns: status === 'idle' ? [] : [{ id: turnId, agentId: thread.agentId, status, interrupt }],
      children: [],
      extensions: {},
      settings: { ...DEFAULT_THREAD_SETTINGS },
      runtime: {
        status,
        agentId: thread.agentId,
        approvalMode: 'request',
        usage,
        taskUsage: usage,
        turnId: status === 'running' || pending ? turnId : undefined,
        interrupt,
      },
    }
  }

  /** 使用原运行身份生成 Composer 消费的完成结果 */
  const finish = (index = 0, status: ClientRunResult['status'] = 'completed') => {
    // 完成前先校准会话，后续队列只能读取最新的权威状态
    const next = runs[index]!
    const current = state(status === 'cancelled' ? 'interrupted' : status)
    update({ thread: current })
    next.completion.resolve({
      agentId: next.run.agentId,
      workspaceId: next.run.workspaceId,
      threadId: next.run.threadId,
      turnId: next.run.turnId,
      status,
      thread: current,
    })
  }
  return { thread, start, runs, listeners, update, state, finish }
}
