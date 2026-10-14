import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { expect, test, vi } from 'vitest'
import {
  completedTurnResult,
  createAgent,
  createEngine,
  createEngineStore,
  disposeEngineStore,
  interruptedTurnResult,
  resolveTestThreadLocation,
  resumableTurnRequest,
  seedParentTurn,
  testId,
  testSubagentRole,
  testSubagentRoles,
  turnModel,
  turnRequest,
} from './support/engine'

test('同一模型显式缺省推理配置经 JSON 持久化后仍可恢复中断', async () => {
  const { root, store } = await createEngineStore()
  let invoked = 0
  const agent = createAgent(context => Promise.resolve(++invoked === 1
    ? interruptedTurnResult(context.turnId)
    : completedTurnResult()))
  const engine = createEngine(agent)
  const request = {
    ...turnRequest('thread-json-config', testId('turn', 'json-config')),
    model: { ...turnModel, config: { ...turnModel.config, reasoning: undefined } },
  }

  try {
    await engine.run(request, store).completed
    expect((await store.turns.read(request.turnId))?.modelConfig).not.toHaveProperty('reasoning')
    const resumed = engine.resume({
      ...request,
      resume: resumableTurnRequest(request.threadId, request.turnId).resume,
    }, store)

    await resumed.accepted
    await resumed.completed
    expect(invoked).toBe(2)
    expect((await store.turns.read(request.turnId))?.status).toBe('completed')
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('同一线程运行位置变化被拒绝且不能改写已持久化事实', async () => {
  const { root, store } = await createEngineStore()
  const invoke = vi.fn(() => Promise.resolve(completedTurnResult()))
  const engine = createEngine(createAgent(invoke))
  const request = turnRequest('thread-runtime-owner', testId('turn', 'runtime-owner'))

  try {
    await engine.run(request, store).completed
    const thread = await store.threads.read(request.threadId)
    const turns = await store.turns.list(request.threadId)
    const changed = {
      ...request,
      turnId: testId('turn', 'runtime-other-location'),
      location: {
        ...request.location,
        workspaceId: 'other-workspace',
        dir: 'other',
        cwd: `${request.location.workspaceRoot}/other`,
      },
    }

    await expect(engine.run(changed, store).completed).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await store.threads.read(request.threadId)).toEqual(thread)
    expect(await store.turns.list(request.threadId)).toEqual(turns)
    expect(await store.turns.read(changed.turnId)).toBeUndefined()
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('恢复请求不能跨 Agent 或 Thread 改写线程归属与工作区事实', async () => {
  const { root, store } = await createEngineStore()
  const invoke = vi.fn((context: { turnId: string }) => Promise.resolve(interruptedTurnResult(context.turnId)))
  const agent = createAgent(invoke)
  const other = defineAgent({ ...agent, id: 'other-agent' })
  const engine = AgentEngine.create({ [agent.id]: agent, [other.id]: other })
  const request = turnRequest('thread-resume-owner', testId('turn', 'resume-owner'))

  try {
    await engine.run(request, store).completed
    const thread = await store.threads.read(request.threadId)
    const turn = await store.turns.read(request.turnId)
    const resumed = {
      ...request,
      resume: resumableTurnRequest(request.threadId, request.turnId).resume,
    }

    await expect(engine.resume({ ...resumed, agentId: other.id }, store).completed).rejects.toThrow()
    await expect(engine.resume({ ...resumed, threadId: 'thread-foreign-new' }, store).completed).rejects.toThrow()
    expect(await store.threads.read('thread-foreign-new')).toBeUndefined()

    await store.threads.upsert({
      id: 'thread-foreign-existing',
      agentId: agent.id,
      dir: 'saved',
      metadata: { workspaceId: 'saved-workspace', marker: 'keep' },
    })
    const foreign = await store.threads.read('thread-foreign-existing')

    await expect(engine.resume({ ...resumed, threadId: foreign!.id }, store).completed).rejects.toThrow()
    expect(await store.threads.read(foreign!.id)).toEqual(foreign)
    expect(await store.threads.read(request.threadId)).toEqual(thread)
    expect(await store.turns.read(request.turnId)).toEqual(turn)
    expect(invoke).toHaveBeenCalledTimes(1)
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('工作区恢复只结算指定 Agent 的孤立 Turn 与扩展状态', async () => {
  const { root, store } = await createEngineStore()
  const settleState = vi.fn(() => ({ owner: { type: 'replace' as const, value: { hook: 'code' } } }))
  const agent = defineAgent({ ...createAgent(() => Promise.resolve(completedTurnResult())), hooks: { settleState } })
  const engine = createEngine(agent)

  try {
    for (const id of ['code', 'other-agent']) {
      await store.threads.upsert({
        id: `thread-orphan-${id}`,
        agentId: id,
        dir: '.',
        status: 'running',
        state: { contextProjection: {}, extensionState: { owner: { hook: id } } },
      })
      await store.turns.create({
        id: testId('turn', `orphan-${id}`),
        threadId: `thread-orphan-${id}`,
        status: 'running',
        modelConfig: { ...turnModel.config },
        agentSnapshot: { id, systemPrompt: id },
        subagentRole: testSubagentRole,
        subagentRoles: testSubagentRoles,
        approvalMode: 'auto',
        subagentMode: 'explicitOnly',
      })
    }
    const other = await store.threads.read('thread-orphan-other-agent')
    const otherTurn = await store.turns.read(testId('turn', 'orphan-other-agent'))

    await engine.recoverWorkspace({ agentId: agent.id, store, resolveThreadLocation: resolveTestThreadLocation() })
    expect((await store.turns.read(testId('turn', 'orphan-code')))?.status).toBe('interrupted')
    expect(settleState).toHaveBeenCalledTimes(1)
    expect(await store.threads.read(other!.id)).toEqual(other)
    expect(await store.turns.read(otherTurn!.id)).toEqual(otherTurn)
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('重复的前台请求被拒绝且不能结算另一个入口接纳的 Turn', async () => {
  const { root, store } = await createEngineStore()
  const invoke = vi.fn(() => Promise.resolve(completedTurnResult()))
  const engine = createEngine(createAgent(invoke))
  const request = turnRequest('thread-duplicate-owner', testId('turn', 'duplicate-owner'))

  try {
    const original = engine.run(request, store)
    const duplicate = engine.run(request, store)
    const rejected = expect(duplicate.completed).rejects.toThrow()

    await original.accepted
    await original.completed
    await rejected
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await store.turns.read(request.turnId))?.status).toBe('completed')
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('新的前台启动不能复活已经结算的 Turn', async () => {
  const { root, store } = await createEngineStore()
  const invoke = vi.fn(() => Promise.resolve(completedTurnResult()))
  const engine = createEngine(createAgent(invoke))
  const request = turnRequest('thread-terminal-owner', testId('turn', 'terminal-owner'))

  try {
    await engine.run(request, store).completed
    const thread = await store.threads.read(request.threadId)
    const turn = await store.turns.read(request.turnId)

    await expect(engine.run(request, store).completed).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await store.threads.read(request.threadId)).toEqual(thread)
    expect(await store.turns.read(request.turnId)).toEqual(turn)
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('冷 Engine 拒绝线程持久作用域变化后仍能在原位置开始下一 Turn', async () => {
  const { root, store } = await createEngineStore()
  const invoke = vi.fn(() => Promise.resolve(completedTurnResult()))
  const agent = createAgent(invoke)
  let engine = createEngine(agent)
  const request = turnRequest('thread-cold-owner', testId('turn', 'cold-owner'))

  try {
    await engine.run(request, store).completed
    await engine.close()

    const changedLocations = [
      { ...request.location, workspaceId: 'foreign-workspace' },
      { ...request.location, dir: 'foreign', cwd: `${request.location.workspaceRoot}/foreign` },
    ]

    for (const [index, location] of changedLocations.entries()) {
      engine = createEngine(agent)
      const thread = await store.threads.read(request.threadId)
      const turns = await store.turns.list(request.threadId)
      const changed = { ...request, location, turnId: testId('turn', `cold-invalid-${index}`) }

      await expect(engine.run(changed, store).completed).rejects.toThrow()
      expect(await store.threads.read(request.threadId)).toEqual(thread)
      expect(await store.turns.list(request.threadId)).toEqual(turns)
      expect(await store.turns.read(changed.turnId)).toBeUndefined()
      await engine.run({ ...request, turnId: testId('turn', `cold-valid-${index}`) }, store).completed
      expect(invoke).toHaveBeenCalledTimes(index + 2)
      await engine.close()
    }
  }
  finally {
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test.each(['interrupt', 'steer'] as const)('活跃 Turn 的 %s 拒绝错误 Agent 且不改变运行与用户消息', async (operation) => {
  const { root, store } = await createEngineStore()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let activeSignal: AbortSignal | undefined
  const invoke = vi.fn(async (context: { signal?: AbortSignal }) => {
    const signal = context.signal

    if (!signal)
      throw new Error('Engine 必须为运行注入取消信号')
    activeSignal = signal
    /** 错误中断也让测试退出，避免断言失败后仍阻塞清理 */
    const onAbort = () => release.resolve()

    signal.addEventListener('abort', onAbort, { once: true })
    entered.resolve()
    try {
      await release.promise
      return completedTurnResult()
    }
    finally {
      signal.removeEventListener('abort', onAbort)
    }
  })
  const agent = createAgent(invoke)
  const other = defineAgent({ ...agent, id: 'other-agent' })
  const engine = AgentEngine.create({ [agent.id]: agent, [other.id]: other })
  const request = turnRequest(`thread-control-${operation}`, testId('turn', `control-${operation}`))

  try {
    const running = engine.run(request, store)

    await running.accepted
    await entered.promise
    const thread = await store.threads.read(request.threadId)
    const turn = await store.turns.read(request.turnId)
    const transcript = await store.transcript.list(request.threadId)
    const canonical = await store.canonical.list(request.threadId)

    for (const agentId of [other.id, 'missing-agent']) {
      const input = { agentId, threadId: request.threadId, turnId: request.turnId, store }

      await expect(operation === 'interrupt'
        ? engine.interrupt(input)
        : engine.steer({ ...input, text: '不能进入别的 Agent 线程' })).rejects.toThrow()
    }
    expect(activeSignal?.aborted).toBe(false)
    expect(await store.threads.read(request.threadId)).toEqual(thread)
    expect(await store.turns.read(request.turnId)).toEqual(turn)
    expect(await store.transcript.list(request.threadId)).toEqual(transcript)
    expect(await store.canonical.list(request.threadId)).toEqual(canonical)
    release.resolve()
    await running.completed
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await store.turns.read(request.turnId))?.status).toBe('completed')
  }
  finally {
    release.resolve()
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('子线程终态通知未退出时拒绝重入恢复且不产生孤立的排程拒绝', async () => {
  const { root, store } = await createEngineStore()
  const notified = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const unhandled: unknown[] = []
  /** 检查所有调度 Promise 都进入拥有者生命周期 */
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  let invoked = 0
  const agent = createAgent(context => Promise.resolve(++invoked === 1
    ? interruptedTurnResult(context.turnId)
    : completedTurnResult()))
  const engine = createEngine(agent)
  const childId = 'thread-child-reentry'
  const childTurnId = testId('turn', 'child-reentry')

  process.on('unhandledRejection', onUnhandled)
  try {
    await seedParentTurn(store, 'thread-parent-reentry', testId('turn', 'parent-reentry'), ['tool-reentry'])
    await store.threads.upsert({
      id: childId,
      agentId: agent.id,
      dir: '.',
      metadata: { workspaceId: 'default' },
      state: { contextProjection: {} },
    })
    await store.turns.create({
      id: childTurnId,
      threadId: childId,
      status: 'queued',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: agent.id, systemPrompt: agent.systemPrompt },
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    await store.spawnEdges.create({
      childThreadId: childId,
      ownerId: 'subagent',
      parentThreadId: 'thread-parent-reentry',
    })
    await store.turnSpawnEdges.create({ childTurnId, parentToolCallId: 'tool-reentry' })
    await engine.submit({
      ...turnRequest(childId, childTurnId),
      onRuntimeEvent: (event) => {
        if (event.type !== 'turn.interrupted')
          return
        notified.resolve()
        return release.promise
      },
    }, store)
    await notified.promise
    const interrupted = await store.turns.read(childTurnId)

    await expect(engine.resume(resumableTurnRequest(childId, childTurnId), store).completed).rejects.toThrow('已在运行')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
    expect(await store.turns.read(childTurnId)).toEqual(interrupted)
    expect(invoked).toBe(1)
    const drained = engine.interrupt({ agentId: agent.id, threadId: childId, turnId: childTurnId, store })

    release.resolve()
    expect(await drained).toBe(false)
    await engine.resume(resumableTurnRequest(childId, childTurnId), store).completed
    expect(invoked).toBe(2)
    expect((await store.turns.read(childTurnId))?.status).toBe('completed')
    expect(unhandled).toEqual([])
  }
  finally {
    release.resolve()
    try {
      await engine.close()
    }
    finally {
      process.removeListener('unhandledRejection', onUnhandled)
      await disposeEngineStore(root, store)
    }
  }
})
