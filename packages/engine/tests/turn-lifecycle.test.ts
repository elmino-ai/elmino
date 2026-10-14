import type { TurnContext } from '@elmino/loop'
import type { RuntimeCreateContext } from '@elmino/runtime'
import type { RuntimeStore, SubagentRole } from '@elmino/store'
import type { RuntimeEvent, ThreadInterrupt } from '@elmino/thread'
import type { TestTurnContext } from './support/engine'
import { JobQueue } from '@elmino/engine/job'
import { createId } from '@elmino/shared'
import { createRuntimeEvent, hydrateThreadMessages } from '@elmino/thread'
import dayjs from 'dayjs'
import { expect, test } from 'vitest'
import {
  completedTurnResult,
  createAgent,
  createEngine,
  createEngineStore,
  createTestRuntime,
  disposeEngineStore,
  interruptedTurnResult,
  posixTest,
  resumableTurnRequest,
  testId,
  testSubagentRole,
  testSubagentRoles,
  turnModel,
  turnRequest,
} from './support/engine'
import { createTestSandbox } from './support/sandbox'

/** -------------------- 测试 -------------------- */
test('AgentEngine accepts the same TurnRequest outside HTTP', async () => {
  const { root, store } = await createEngineStore()

  try {
    const seen: TestTurnContext[] = []
    const engine = createEngine(createAgent((options) => {
      seen.push(options)
      return Promise.resolve(completedTurnResult())
    }))

    await engine.run({
      ...turnRequest('thread-direct', testId('turn', 'direct')),
      input: [{ type: 'text', text: '直接运行' }],
    }, store).completed

    expect(seen[0]).toMatchObject({
      threadId: 'thread-direct',
      turnId: testId('turn', 'direct'),
      subagentRole: { id: testSubagentRole.id },
    })
    expect(seen[0]?.parentThreadId).toBeUndefined()
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.testAuxQueue).toBeInstanceOf(JobQueue)
    expect(await store.turns.list('thread-direct')).toContainEqual(expect.objectContaining({
      id: testId('turn', 'direct'),
      status: 'completed',
    }))
    expect(await hydrateThreadMessages({ store, threadId: 'thread-direct' })).toContainEqual(expect.objectContaining({
      role: 'user',
      turnId: testId('turn', 'direct'),
    }))
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine queues background root Turns for future scheduled submission', async () => {
  const { root, store } = await createEngineStore()
  let releaseRunning = () => {}
  let engine: ReturnType<typeof createEngine> | undefined

  try {
    let markRunningStarted!: () => void
    const runningStarted = new Promise<void>((resolve) => {
      markRunningStarted = resolve
    })
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve
    })
    const providerTurnIds: string[] = []
    const requests = Array.from({ length: 5 }, (_, index) => (
      turnRequest(
        `thread-background-root-${index}`,
        testId('turn', `background-root-${index}`),
      )
    ))

    engine = createEngine(createAgent(async (context) => {
      providerTurnIds.push(context.turnId)
      if (providerTurnIds.length === 4)
        markRunningStarted()
      await runningGate
      return completedTurnResult()
    }))
    const handles = await Promise.all(
      requests.map(request => engine!.submit(request, store)),
    )

    await runningStarted
    expect(handles.map(handle => handle.status)).toEqual([
      'running',
      'running',
      'running',
      'running',
      'queued',
    ])

    const closing = engine.close()

    releaseRunning()
    await closing
    expect(providerTurnIds).toEqual(requests.slice(0, 4).map(request => request.turnId))
    for (const request of requests) {
      expect(await store.turns.read(request.turnId)).toMatchObject({
        status: 'interrupted',
        errorMessage: 'AgentEngine 正在关闭',
      })
      expect((await store.threads.read(request.threadId))?.unreadAt).toBeNull()
    }
  }
  finally {
    releaseRunning()
    await engine?.close()
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine preserves atomic completed tool results while settling a failed Turn', async () => {
  const { root, store } = await createEngineStore()
  const threadId = 'thread-tool-result-settle'
  const turnId = testId('turn', 'tool-result-settle')
  const call = {
    type: 'tool-call' as const,
    id: 'toolu_result_settle',
    name: 'writeFile',
    args: { path: 'result.txt' },
  }

  try {
    const agent = createAgent(async () => {
      await store.transaction(async (tx) => {
        await tx.canonical.append({
          id: 'canonical_message_11111111-1111-4111-8111-111111111111',
          threadId,
          turnId,
          role: 'assistant',
          finishReason: 'tool-calls',
          parts: [{
            id: 'canonical_part_11111111-1111-4111-8111-111111111111',
            type: 'tool-call',
            content: call,
          }],
        })
        const createdAt = dayjs().toISOString()
        const messageId = createId('msg')
        const partId = createId('part')

        await tx.transcript.upsert({
          id: messageId,
          threadId,
          turnId,
          role: 'assistant',
          kind: 'normal',
          status: 'completed',
          parts: [{
            id: partId,
            messageId,
            threadId,
            turnId,
            seq: 1,
            type: 'tool',
            status: 'completed',
            toolName: call.name,
            args: call.args,
            createdAt,
            updatedAt: createdAt,
          }],
          createdAt,
          updatedAt: createdAt,
          metadata: {},
        })
        const ownership = await tx.toolCalls.create({
          turnId,
          assistantMessageId: messageId,
          assistantPartId: partId,
          providerCallId: call.id,
          name: call.name,
          args: call.args,
          status: 'completed',
        })
        const resultPartId = 'canonical_part_22222222-2222-4222-8222-222222222222'

        await tx.canonical.append({
          id: 'canonical_message_22222222-2222-4222-8222-222222222222',
          threadId,
          turnId,
          role: 'tool',
          parts: [{
            id: resultPartId,
            type: 'tool-result',
            content: {
              type: 'tool-result',
              callId: call.id,
              result: 'write completed',
            },
          }],
        })

        await tx.toolCalls.update(ownership.id, {
          completedAt: dayjs().toISOString(),
          resultPartId,
        })
      })

      // 模拟 Loop 已落盘 ToolCall 终态，但尚未落盘 ToolResult snapshot
      throw new Error('模拟 ToolResult snapshot 失败')
    })
    const engine = createEngine(agent)

    await expect(
      engine.run(turnRequest(threadId, turnId), store).completed,
    ).rejects.toThrow('模拟 ToolResult snapshot 失败')

    const [turn, tools] = await Promise.all([
      store.turns.read(turnId),
      store.toolCalls.list({ turnId }),
    ])
    const resultPart = await store.canonical.readPart(
      threadId,
      tools[0]!.resultPartId!,
    )
    const transcript = await hydrateThreadMessages({ store, threadId })
    const toolPart = transcript
      .flatMap(message => message.parts)
      .find(part => part.type === 'tool')
    const storedToolPart = (await store.transcript.list(threadId))
      .flatMap(message => message.parts)
      .find(part => part.type === 'tool')

    expect(turn?.status).toBe('failed')
    expect(tools[0]).toMatchObject({
      status: 'completed',
    })
    expect(resultPart?.content).toEqual({
      type: 'tool-result',
      callId: call.id,
      result: 'write completed',
    })
    expect(toolPart).toMatchObject({
      status: 'completed',
      output: 'write completed',
    })
    expect(storedToolPart).not.toHaveProperty('output')
    expect(await store.transcript.list(threadId)).toHaveLength(1)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine settles pending tools when an Interaction is cancelled', async () => {
  const { root, store } = await createEngineStore()
  const threadId = 'thread-interaction-cancel-tools'
  const turnId = testId('turn', 'interaction-cancel-tools')
  const ownerId = 'test.cancel-tools'
  const call = {
    type: 'tool-call' as const,
    id: 'toolu_interaction_cancel',
    name: 'plan',
    args: { title: '待取消计划' },
  }

  try {
    let invocations = 0
    const agent = createAgent(() => {
      invocations++
      return Promise.resolve(interruptedTurnResult(turnId, ownerId))
    }, {
      resolveInteraction: ({ interrupt, response }) => (
        interrupt.ownerId === ownerId && response === 'cancel'
          ? { action: 'cancel', response }
          : undefined
      ),
    })
    const engine = createEngine(agent)

    await engine.run(turnRequest(threadId, turnId), store).completed
    const interruptedUnreadAt = (await store.threads.read(threadId))?.unreadAt

    expect(interruptedUnreadAt).toBeTypeOf('string')
    await store.transaction(async (tx) => {
      await tx.canonical.append({
        id: 'canonical_message_33333333-3333-4333-8333-333333333333',
        threadId,
        turnId,
        role: 'assistant',
        finishReason: 'tool-calls',
        parts: [{
          id: 'canonical_part_33333333-3333-4333-8333-333333333333',
          type: 'tool-call',
          content: call,
        }],
      })
      const createdAt = dayjs().toISOString()
      const messageId = createId('msg')
      const partId = createId('part')

      await tx.transcript.upsert({
        id: messageId,
        threadId,
        turnId,
        role: 'assistant',
        kind: 'normal',
        status: 'completed',
        parts: [{
          id: partId,
          messageId,
          threadId,
          turnId,
          seq: 1,
          type: 'tool',
          status: 'completed',
          toolName: call.name,
          args: call.args,
          createdAt,
          updatedAt: createdAt,
        }],
        createdAt,
        updatedAt: createdAt,
        metadata: {},
      })

      await tx.toolCalls.create({
        turnId,
        assistantMessageId: messageId,
        assistantPartId: partId,
        providerCallId: call.id,
        name: call.name,
        args: call.args,
        status: 'pending',
      })
    })

    await engine.resume({
      ...resumableTurnRequest(threadId, turnId),
      resume: {
        interruptId: testId('interrupt', turnId),
        response: 'cancel',
      },
    }, store).completed

    const [turn, thread, tools] = await Promise.all([
      store.turns.read(turnId),
      store.threads.read(threadId),
      store.toolCalls.list({ turnId }),
    ])
    const resultPart = await store.canonical.readPart(
      threadId,
      tools[0]!.resultPartId!,
    )

    expect(invocations).toBe(1)
    expect(turn?.status).toBe('cancelled')
    expect(thread?.unreadAt).toBe(interruptedUnreadAt)
    expect(thread?.unreadAt).not.toBe(turn?.endedAt)
    expect(tools[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'Interaction 已取消',
    })
    expect(resultPart?.content).toEqual({
      type: 'tool-result',
      callId: call.id,
      name: call.name,
      result: 'Interaction 已取消',
      error: true,
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine does not replay Mention inputs on Interaction resume', async () => {
  const { root, store } = await createEngineStore()

  try {
    const threadId = 'thread-resume-mentions'
    const turnId = testId('turn', 'resume-mentions')
    const seen: TurnContext['input'][] = []
    let interrupted = false
    const agent = createAgent((context) => {
      seen.push(context.input)

      if (!interrupted) {
        interrupted = true
        return Promise.resolve(interruptedTurnResult(turnId))
      }

      return Promise.resolve(completedTurnResult())
    })
    const engine = createEngine(agent)
    const mention = {
      type: 'mention' as const,
      pluginId: 'host.skill',
      resourceId: 'skill_project_chrome',
      trigger: '$',
      label: 'Chrome',
      data: { source: 'project', origin: 'Claude' },
    }

    await engine.run({
      ...turnRequest(threadId, turnId),
      input: [
        { type: 'text', text: '使用 ' },
        mention,
        { type: 'text', text: ' 完成任务' },
      ],
    }, store).completed
    await engine.resume(resumableTurnRequest(threadId, turnId), store).completed

    expect(seen[0]?.messages).toHaveLength(1)
    expect(seen[1]?.messages).toEqual([])
    const persisted = await hydrateThreadMessages({ store, threadId })

    expect(persisted.flatMap(message => message.parts)).toContainEqual(expect.objectContaining(mention))
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine freezes one Runtime and Store for an active Turn', async () => {
  const { root, store } = await createEngineStore()

  try {
    const runtimeContexts: RuntimeCreateContext[] = []
    let invokedStore: RuntimeStore | undefined
    const agent = createAgent(async (options) => {
      invokedStore = options.services.store

      expect(await options.testSubagents!.list()).toEqual([])
      expect(await options.testSubagents!.wait({
        threadIds: [],
        timeoutMs: 0,
      })).toEqual({
        timedOut: true,
        subagents: [],
      })

      return completedTurnResult()
    })

    agent.runtime.create = (context) => {
      runtimeContexts.push(context)
      return createTestRuntime(context.location)
    }

    const engine = createEngine(agent)
    const request = turnRequest('thread-services', testId('turn', 'services'))

    await engine.run(request, store).completed
    await engine.listChildren({
      agentId: 'code',
      parentThreadId: 'thread-services',
      store,
    })

    expect(runtimeContexts).toHaveLength(1)
    expect(runtimeContexts[0]?.location).not.toBe(request.location)
    expect(Object.isFrozen(runtimeContexts[0]?.location)).toBe(true)
    expect(invokedStore).toBe(store)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine reuses one Thread Runtime until disposeRuntimes closes it', async () => {
  const { root, store } = await createEngineStore()

  try {
    let runtimeCreates = 0
    let runtimeDisposes = 0
    let disposalFails = true
    const agent = createAgent(
      () => Promise.resolve(completedTurnResult()),
    )

    agent.runtime.create = ({ location }) => {
      runtimeCreates += 1

      const runtime = createTestRuntime(location)

      return {
        location: runtime.location,
        sandbox: () => runtime.sandbox(),
        dispose: () => {
          runtimeDisposes += 1
          if (disposalFails) {
            disposalFails = false
            return Promise.reject(new Error('模拟 Runtime 释放失败'))
          }

          return Promise.resolve()
        },
      }
    }
    const engine = createEngine(agent)
    const threadId = 'thread-runtime-reuse'

    await engine.run(turnRequest(threadId, testId('turn', 'runtime-reuse-1')), store).completed
    await engine.run(turnRequest(threadId, testId('turn', 'runtime-reuse-2')), store).completed

    expect(runtimeCreates).toBe(1)
    expect(runtimeDisposes).toBe(0)

    await expect(engine.disposeRuntimes([threadId])).rejects.toThrow('关闭 Thread Runtime 失败')
    await engine.disposeRuntimes([threadId])
    await engine.disposeRuntimes([threadId])
    expect(runtimeDisposes).toBe(2)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

posixTest('AgentEngine keeps one Shell session controllable across completed Turns', async () => {
  const { root, store } = await createEngineStore()
  const sandbox = createTestSandbox(root)
  const threadId = 'thread-shell-across-turns'
  let sessionId: string | undefined
  let invocation = 0
  const agent = createAgent(async (context) => {
    invocation += 1

    if (invocation === 1) {
      const result = await context.services.runtime.sandbox().shell.run(
        'sleep 30',
        { shell: 'sh', yield: 0.25 },
      )

      sessionId = result.sessionId
      expect(result.status).toBe('running')
    }
    else if (invocation === 2) {
      const polled = await context.services.runtime.sandbox().shell.write(
        sessionId!,
        { yield: 0.25 },
      )

      expect(polled).toMatchObject({ status: 'running', sessionId })
      throw new Error('模拟 Turn 失败')
    }
    else {
      const terminated = await context.services.runtime.sandbox().shell.terminate(sessionId!)

      expect(terminated.status).toBe('terminated')
    }

    return completedTurnResult()
  })
  const runtime = {
    ...createTestRuntime(),
    sandbox: () => sandbox,
    dispose: () => sandbox.shell.dispose(),
  }

  agent.runtime.create = () => runtime
  const engine = createEngine(agent)

  try {
    await engine.run(turnRequest(threadId, testId('turn', 'shell-across-turns-1')), store).completed
    const failedTurnId = testId('turn', 'shell-across-turns-2')

    await expect(engine.run(
      turnRequest(threadId, failedTurnId),
      store,
    ).completed).rejects.toThrow('模拟 Turn 失败')
    const [failedTurn, failedThread] = await Promise.all([
      store.turns.read(failedTurnId),
      store.threads.read(threadId),
    ])

    expect(failedThread?.unreadAt).toBe(failedTurn?.endedAt)
    await engine.run(turnRequest(threadId, testId('turn', 'shell-across-turns-3')), store).completed

    expect(invocation).toBe(3)
    expect(sessionId).toMatch(/^process_/)
  }
  finally {
    await engine.disposeRuntimes([threadId])
    await sandbox.shell.dispose()
    await disposeEngineStore(root, store)
  }
}, 5_000)

test('AgentEngine isolates Thread Runtimes and closes only selected Threads', async () => {
  const { root, store } = await createEngineStore()

  try {
    const disposed = new Map<string, number>()
    const agent = createAgent(
      () => Promise.resolve(completedTurnResult()),
    )

    agent.runtime.create = ({ location }) => {
      const runtime = createTestRuntime(location)

      return {
        location: runtime.location,
        sandbox: () => runtime.sandbox(),
        dispose: () => {
          const count = disposed.get(location.workspaceId) ?? 0

          disposed.set(location.workspaceId, count + 1)
          return runtime.dispose()
        },
      }
    }
    const engine = createEngine(agent)
    const defaultThreadIds = ['thread-runtime-default-a', 'thread-runtime-default-b']
    const otherThreadId = 'thread-runtime-other'
    const otherRequest = turnRequest(otherThreadId, testId('turn', 'runtime-other'))

    otherRequest.location = {
      ...otherRequest.location,
      workspaceId: 'other',
      workspaceRoot: '/tmp/elmino-agent-engine-other',
      cwd: '/tmp/elmino-agent-engine-other',
    }
    await Promise.all([
      engine.run(turnRequest(defaultThreadIds[0]!, testId('turn', 'runtime-default-a')), store).completed,
      engine.run(turnRequest(defaultThreadIds[1]!, testId('turn', 'runtime-default-b')), store).completed,
      engine.run(otherRequest, store).completed,
    ])

    await engine.disposeRuntimes(defaultThreadIds)
    expect(disposed).toEqual(new Map([['default', 2]]))

    await engine.disposeRuntimes([otherThreadId])
    expect(disposed).toEqual(new Map([
      ['default', 2],
      ['other', 1],
    ]))
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine close attempts every Runtime when one close fails', async () => {
  const { root, store } = await createEngineStore()

  try {
    let runtimeCreates = 0
    let runtimeDisposes = 0
    const agent = createAgent(
      () => Promise.resolve(completedTurnResult()),
    )

    agent.runtime.create = ({ location }) => {
      runtimeCreates += 1
      const runtimeIndex = runtimeCreates

      const runtime = createTestRuntime(location)

      return {
        location: runtime.location,
        sandbox: () => runtime.sandbox(),
        dispose: () => {
          runtimeDisposes += 1

          return runtimeIndex === 1
            ? Promise.reject(new Error('模拟 Runtime 释放失败'))
            : Promise.resolve()
        },
      }
    }
    const engine = createEngine(agent)

    await engine.run(turnRequest('thread-close-failure-a', testId('turn', 'close-failure-a')), store).completed
    await engine.run(turnRequest('thread-close-failure-b', testId('turn', 'close-failure-b')), store).completed

    await expect(engine.close()).rejects.toThrow('关闭 Thread Runtime 失败')
    expect(runtimeDisposes).toBe(2)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine releases the entry reservation while keeping the workspace permit until settle', async () => {
  const { root, store } = await createEngineStore()
  let releaseTurn!: () => void

  try {
    let releases = 0
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const agent = createAgent(async () => {
      started()
      await gate
      return completedTurnResult()
    })
    const engine = createEngine(agent, {
      acquireWorkspace: () => ({
        release: () => {
          releases += 1
        },
      }),
    })
    const result = engine.run(
      turnRequest('thread-workspace-permit', testId('turn', 'workspace-permit')),
      store,
    ).completed

    await running
    await engine.beginThreadClose('thread-workspace-permit')
    expect(releases).toBe(0)
    releaseTurn()
    await result
    expect(releases).toBe(1)
  }
  finally {
    releaseTurn?.()
    await disposeEngineStore(root, store)
  }
})

test('An unaccepted Runtime preparation failure cannot settle an existing queued Turn', async () => {
  const { root, store } = await createEngineStore()

  try {
    const events: RuntimeEvent[] = []
    const request = {
      ...turnRequest(
        'thread-runtime-create-failure',
        testId('turn', 'runtime-create-failure'),
      ),
      onRuntimeEvent: (event: RuntimeEvent) => {
        events.push(event)
      },
    }
    await store.threads.upsert({
      id: request.threadId,
      dir: request.location.dir,
      agentId: request.agentId,
      status: 'idle',
    })
    await store.turns.create({
      id: request.turnId,
      threadId: request.threadId,
      status: 'queued',
      modelConfig: { ...turnModel.config },
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      agentSnapshot: {
        id: 'code',
        systemPrompt: 'test',

      },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    let runtimeCreations = 0
    const agent = createAgent(
      () => Promise.resolve(completedTurnResult()),
    )

    agent.runtime.create = () => {
      runtimeCreations += 1
      throw new Error('Runtime 创建失败')
    }
    const originalTurn = await store.turns.read(request.turnId)
    const originalThread = await store.threads.read(request.threadId)

    await expect(createEngine(agent).submit(request, store))
      .rejects
      .toThrow('Runtime 创建失败')
    expect(runtimeCreations).toBe(1)
    expect(await store.turns.read(request.turnId)).toEqual(originalTurn)
    const thread = await store.threads.read(request.threadId)

    expect(thread).toEqual(originalThread)
    expect(events).toEqual([])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine preserves the original Runtime creation failure without reopening it', async () => {
  const { root, store } = await createEngineStore()

  try {
    const failure = new Error('Runtime 首次创建失败')
    let runtimeCreations = 0
    const agent = createAgent(
      () => Promise.resolve(completedTurnResult()),
    )

    agent.runtime.create = () => {
      runtimeCreations += 1
      throw failure
    }

    const { completed } = createEngine(agent).run(
      turnRequest('thread-runtime-original-error', testId('turn', 'runtime-original-error')),
      store,
    )
    const caught = await completed.catch(error => error)

    expect(caught).toBe(failure)
    expect(runtimeCreations).toBe(1)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine rolls back Interaction state, message, and Turn claim together', async () => {
  const { root, store } = await createEngineStore()

  try {
    const threadId = 'thread-interaction-rollback'
    const turnId = testId('turn', 'interaction-rollback')
    const ownerId = 'test.rollback'
    let invoked = false
    const agent = createAgent(() => {
      if (!invoked) {
        invoked = true
        return Promise.resolve(interruptedTurnResult(turnId, ownerId))
      }

      return Promise.resolve(completedTurnResult())
    }, {
      resolveInteraction: ({ interrupt, response }) => (
        interrupt.ownerId === ownerId && response === 'continue'
          ? {
              action: 'resume',
              response,
              state: { [ownerId]: { type: 'replace', value: { stage: 'resolved' } } },
              input: '恢复输入不应在回滚后残留',
            }
          : undefined
      ),
    })
    const engine = createEngine(agent)

    await engine.run(turnRequest(threadId, turnId), store).completed
    await store.threads.upsert({
      id: threadId,
      state: {
        contextProjection: {},
        extensionState: {
          [ownerId]: { stage: 'pending' },
        },
      },
    })

    const transaction = store.transaction.bind(store)
    let resumeTransactionCount = 0

    store.transaction = (callback) => {
      resumeTransactionCount++

      if (resumeTransactionCount !== 2)
        return transaction(callback)

      return transaction(async (tx) => {
        await callback(tx)
        throw new Error('模拟 Interaction 启动事务回滚')
      })
    }

    await expect(engine.resume(resumableTurnRequest(threadId, turnId), store).completed)
      .rejects
      .toThrow('模拟 Interaction 启动事务回滚')

    expect(await store.turns.read(turnId)).toMatchObject({
      status: 'interrupted',
      interrupt: {
        id: testId('interrupt', turnId),
        status: 'pending',
      },
    })
    expect((await store.threads.read(threadId))?.state.extensionState).toEqual({
      [ownerId]: { stage: 'pending' },
    })
    expect(await store.transcript.list(threadId)).toEqual([])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('文件 Mention 只向模型提供路径并在执行历史中保留完整引用', async () => {
  const { root, store } = await createEngineStore()

  try {
    const seen: TurnContext[] = []
    const engine = createEngine(createAgent((context) => {
      seen.push(context)
      return Promise.resolve(completedTurnResult())
    }))
    const mentions = ['main.ts', 'image.png'].map(name => ({
      type: 'mention' as const,
      pluginId: 'explorer',
      trigger: '@',
      resourceId: name,
      label: `${root}/not-present/${name}`,
      data: { workspaceId: 'workspace_source' },
    }))
    await engine.run({
      ...turnRequest('thread-file-mentions', testId('turn', 'file-mentions')),
      input: mentions,
    }, store).completed

    expect(seen[0]?.input.messages?.map(item => item.message)).toEqual([{
      role: 'user',
      parts: mentions.map(mention => ({ type: 'text', text: mention.label })),
    }])
    const [transcript] = await hydrateThreadMessages({ store, threadId: 'thread-file-mentions' })
    expect(transcript!.parts).toEqual(mentions.map(mention => expect.objectContaining(mention)))
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine persists structured input and derives one standard provider message', async () => {
  const { root, store } = await createEngineStore()

  try {
    const seen: TurnContext[] = []
    const engine = createEngine(createAgent((options) => {
      seen.push(options)
      return Promise.resolve(completedTurnResult())
    }))

    await engine.run({
      ...turnRequest('thread-input-parts', testId('turn', 'input-parts')),
      input: [{
        type: 'image',
        name: 'diagram.png',
        mime: 'image/png',
        data: 'aGVsbG8=',
      }, {
        type: 'document',
        name: '说明.md',
        extension: 'md',
        artifactId: 'artifact_55555555-5555-4555-8555-555555555555',
        modelText: '<document>文档正文</document>',
      }, {
        type: 'text',
        text: '请分析',
      }],
    }, store).completed

    expect(seen[0]?.input.messages?.map(item => item.message)).toEqual([{
      role: 'user',
      parts: [{
        type: 'image',
        mime: 'image/png',
        data: 'aGVsbG8=',
      }, {
        type: 'text',
        text: '<document>文档正文</document>',
      }, {
        type: 'text',
        text: '请分析',
      }],
    }])

    const [transcript] = await hydrateThreadMessages({
      store,
      threadId: 'thread-input-parts',
    })
    const parts = transcript!.parts

    expect(parts.map(part => part.type)).toEqual([
      'image',
      'document',
      'text',
    ])
    expect(parts[1]).toMatchObject({
      name: '说明.md',
      extension: 'md',
      artifactId: 'artifact_55555555-5555-4555-8555-555555555555',
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine publishes buffered terminal events with the persisted Turn end time', async () => {
  const { root, store } = await createEngineStore()

  try {
    const events: RuntimeEvent[] = []
    const metadataUpdatedAt = dayjs().add(1, 'minute').toISOString()
    const loopEvent = createRuntimeEvent({
      type: 'turn.completed',
      threadId: 'thread-terminal-time',
      turnId: testId('turn', 'terminal-time'),
      messageId: 'message-terminal-time',
      createdAt: '2026-06-25T00:00:01.000Z',
      payload: { stopReason: 'end_turn' },
    })
    const engine = createEngine(createAgent(async (options) => {
      await options.onRuntimeEvent?.(loopEvent)
      await store.threads.upsert({
        id: 'thread-terminal-time',
        updatedAt: metadataUpdatedAt,
      })

      return completedTurnResult()
    }))

    await engine.run({
      ...turnRequest('thread-terminal-time', testId('turn', 'terminal-time')),
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    }, store).completed

    const turn = await store.turns.read(testId('turn', 'terminal-time'))
    const thread = await store.threads.read('thread-terminal-time')
    const terminalEvent = events.find(event => event.type === 'turn.completed')

    expect(turn?.endedAt).toBeTypeOf('string')
    expect(dayjs(turn?.endedAt).isAfter(metadataUpdatedAt)).toBe(true)
    expect(thread?.updatedAt).toBe(turn?.endedAt)
    expect(thread?.unreadAt).toBe(turn?.endedAt)
    expect(terminalEvent).toMatchObject({
      id: loopEvent.id,
      messageId: loopEvent.messageId,
      createdAt: turn?.endedAt,
      payload: {
        ...loopEvent.payload,
        unreadAt: turn?.endedAt,
      },
    })
    expect(terminalEvent?.createdAt).not.toBe(loopEvent.createdAt)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine replaces a provisional interrupted event with the persisted interrupt', async () => {
  const { root, store } = await createEngineStore()

  try {
    const threadId = 'thread-canonical-interrupt-event'
    const turnId = testId('turn', 'canonical-interrupt-event')
    const interrupt = {
      id: testId('interrupt', 'canonical-interrupt-event'),
      kind: 'interaction',
      interaction: 'question',
      ownerId: 'plan',
      status: 'pending',
      turnId,
      reason: '等待用户补充信息',
      payload: {
        callId: 'toolu_canonical_interrupt',
        questions: [],
      },
      createdAt: '2026-06-25T00:00:01.000Z',
      resumableWith: ['interaction'],
    } satisfies ThreadInterrupt
    const events: RuntimeEvent[] = []
    const engine = createEngine(createAgent(async (options) => {
      await options.onRuntimeEvent?.(createRuntimeEvent({
        type: 'turn.interrupted',
        threadId,
        turnId,
        payload: { reason: 'Loop 临时中断信息' },
      }))

      return {
        outcome: {
          status: 'interrupted',
          interrupt,
        },
      }
    }))

    await engine.run({
      ...turnRequest(threadId, turnId),
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    }, store).completed

    const turn = await store.turns.read(turnId)
    const thread = await store.threads.read(threadId)
    const terminal = events.find(event => event.type === 'turn.interrupted')

    expect(turn?.interrupt).toEqual(interrupt)
    expect(thread?.unreadAt).toBe(turn?.endedAt)
    expect(terminal).toMatchObject({
      type: 'turn.interrupted',
      interruptId: interrupt.id,
      payload: {
        ...interrupt,
        unreadAt: turn?.endedAt,
      },
      createdAt: turn?.endedAt,
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine freezes the root role catalog and restores it without rereading config', async () => {
  const { root, store } = await createEngineStore()

  try {
    const explorerRole = {
      id: 'explorer',
      name: '调研',
      description: '测试冻结的调研角色',
      icon: 'compass',
      instructions: '只进行只读调研。',
    } satisfies SubagentRole
    const changedRole = {
      id: 'worker',
      name: '执行',
      description: '恢复前修改后的角色目录',
      icon: 'tool',
      instructions: '完成代码修改。',
    } satisfies SubagentRole
    const frozenRoles = [testSubagentRole, explorerRole]
    let configuredRoles = frozenRoles
    let readCalls = 0
    const resolveSubagentRoles = () => {
      readCalls++
      return Promise.resolve(configuredRoles)
    }
    const seen: SubagentRole[][] = []
    const turnId = testId('turn', 'frozen-roles')
    let interrupted = false

    const agent = createAgent((options) => {
      seen.push(options.subagentRoles)

      if (!interrupted) {
        interrupted = true
        return Promise.resolve(interruptedTurnResult(turnId))
      }

      return Promise.resolve(completedTurnResult())
    })
    const engine = createEngine(agent, { resolveSubagentRoles })

    await engine.run(turnRequest('thread-frozen-roles', turnId), store).completed
    expect(await store.turns.read(turnId)).toMatchObject({
      status: 'interrupted',
      subagentRole: testSubagentRole,
      subagentRoles: frozenRoles,
    })

    configuredRoles = [testSubagentRole, changedRole]
    await engine.resume(resumableTurnRequest('thread-frozen-roles', turnId), store).completed

    expect(seen).toEqual([frozenRoles, frozenRoles])
    expect(readCalls).toBe(1)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine rejects resume when Turn is not interrupted', async () => {
  const { root, store } = await createEngineStore()

  try {
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-terminal', status: 'completed', state: { contextProjection: {} } })
    await store.turns.create({
      id: testId('turn', 'terminal'),
      threadId: 'thread-terminal',
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      status: 'completed',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    const engine = createEngine(createAgent(() => {
      throw new Error('非法状态不应调用 Agent')
    }))

    await expect(engine.resume(turnRequest('thread-terminal', testId('turn', 'terminal')), store).completed)
      .rejects
      .toThrow('Turn 不是可恢复状态')
    expect(await store.transcript.list('thread-terminal')).toEqual([])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})
