import type { TurnHandle } from '@elmino/engine'
import type { RuntimeStore, RuntimeStoreTx } from '@elmino/store'
import type { RuntimeEvent, ThreadInterrupt } from '@elmino/thread'

import type { TestTurnContext } from './support/engine'
import { canonicalRecordToMessage } from '@elmino/thread'
import dayjs from 'dayjs'
import { expect, test } from 'vitest'

import {
  completedTurnResult,
  createAgent,
  createEngine,
  createEngineStore,
  createTestRuntime,
  disposeEngineStore,
  resumableTurnRequest,
  seedParentTurn,
  testId,
  testResumeInterrupt,
  testSubagentRole,
  turnModel,
  turnRequest,
  waitForChildTurns,
} from './support/engine'

/** -------------------- 测试 -------------------- */
test('A newly created child is failed when runtime preparation prevents queue ownership', async () => {
  const { root, store } = await createEngineStore()
  const parentTurnId = testId('turn', 'child-runtime-preparation-failure')
  const failure = new Error('Child Runtime cannot be created')

  try {
    await seedParentTurn(store, 'thread-parent', parentTurnId, ['tool-child-runtime'])
    const agent = createAgent(async (context) => {
      await context.testSubagents!.spawn({
        role: testSubagentRole.id,
        name: 'Child preparation failure',
        description: 'Keep the child failure associated with its parent tool',
        ownerId: 'subagent',
        parentToolCallId: 'tool-child-runtime',
      })
      return completedTurnResult()
    })
    let runtimeCreates = 0

    agent.runtime.create = ({ location }) => {
      runtimeCreates++
      if (runtimeCreates > 1)
        throw failure
      return createTestRuntime(location)
    }
    const engine = createEngine(agent)

    await expect(engine.resume(resumableTurnRequest('thread-parent', parentTurnId), store).completed)
      .rejects
      .toBe(failure)
    const edges = await store.turnSpawnEdges.listChildren(parentTurnId)

    expect(edges).toHaveLength(1)
    expect(edges[0]?.parentToolCallId).toBe('tool-child-runtime')
    const child = await store.turns.read(edges[0]!.childTurnId)

    expect(child).toMatchObject({ status: 'failed', errorMessage: failure.message })
    expect((await store.threads.read(child!.threadId))?.status).toBe('failed')
    expect((await engine.listChildren({ agentId: 'code', parentThreadId: 'thread-parent', store }))[0])
      .toMatchObject({ status: 'failed', turnId: child!.id })
    await engine.close()
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine never re-executes a persisted running Child Turn without local ownership', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(
      store,
      'thread-parent',
      testId('turn', 'parent'),
      ['tool-parent'],
      'proactive',
    )
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-child', metadata: {
      workspaceRoot: '/tmp/elmino-agent-engine',
      cwd: '/tmp/elmino-agent-engine',
      workspaceId: 'default',
    }, state: { contextProjection: {} } })
    await store.turns.create({
      id: testId('turn', 'child'),
      threadId: 'thread-child',
      subagentRole: testSubagentRole,
      subagentRoles: [],
      status: 'running',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    await store.spawnEdges.create({
      childThreadId: 'thread-child',
      ownerId: 'subagent',
      parentThreadId: 'thread-parent',
    })
    await store.turnSpawnEdges.create({
      childTurnId: testId('turn', 'child'),
      parentToolCallId: 'tool-parent',
    })
    let invocationCount = 0
    const engine = createEngine(createAgent(() => {
      invocationCount += 1
      return Promise.resolve(completedTurnResult())
    }))

    await expect(engine.submit(turnRequest('thread-child', testId('turn', 'child')), store))
      .rejects
      .toThrow('Turn 正在由其他执行器处理')
    expect(invocationCount).toBe(0)
    expect(await store.turns.read(testId('turn', 'child'))).toMatchObject({ status: 'running' })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine does not inject undeclared SubAgent tool guidance', async () => {
  const { root, store } = await createEngineStore()

  try {
    const parentTurnId = testId('turn', 'parent-guidance')
    const childTurnId = testId('turn', 'child-guidance')

    await seedParentTurn(
      store,
      'thread-parent',
      parentTurnId,
      ['tool-parent'],
    )
    await store.threads.upsert({
      dir: '.',
      agentId: 'code',
      id: 'thread-child',
      userTitle: '调研任务',
      metadata: {
        workspaceRoot: '/tmp/elmino-agent-engine',
        cwd: '/tmp/elmino-agent-engine',
        workspaceId: 'default',
      },
      state: { contextProjection: {} },
    })
    await store.turns.create({
      id: childTurnId,
      threadId: 'thread-child',
      subagentRole: testSubagentRole,
      subagentRoles: [],
      status: 'running',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    await store.spawnEdges.create({
      childThreadId: 'thread-child',
      ownerId: 'subagent',
      parentThreadId: 'thread-parent',
    })
    await store.turnSpawnEdges.create({
      childTurnId,
      parentToolCallId: 'tool-parent',
    })
    let hiddenMessages: TestTurnContext['input']['hiddenMessages']
    const engine = createEngine(createAgent((context) => {
      hiddenMessages = context.input.hiddenMessages
      return Promise.resolve(completedTurnResult())
    }))

    await engine.resume(resumableTurnRequest('thread-parent', parentTurnId), store).completed

    expect(hiddenMessages).toEqual([])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('Spawn returns its existing child when publication lets another submission accept it first', async () => {
  const { root, store } = await createEngineStore()
  const parentTurnId = testId('turn', 'spawn-during-publication')
  const preparing = Promise.withResolvers<void>()
  const input = Promise.withResolvers<[]>()
  let childInvocations = 0
  let submitted: Promise<TurnHandle | { error: unknown }> | undefined
  let handle: { threadId: string, turnId: string } | undefined
  let adopted = false
  const engine = createEngine(createAgent(async (context) => {
    if (context.parentThreadId) {
      childInvocations++
      return completedTurnResult()
    }
    handle = await context.testSubagents!.spawn({
      role: testSubagentRole.id,
      name: 'Publication adoption',
      description: 'Preserve one child for the same parent tool invocation',
      ownerId: 'subagent',
      parentToolCallId: 'tool-publication',
    })
    return completedTurnResult()
  }), {
    onRuntimeEvent: async (_agentId, event) => {
      if (event.type !== 'thread.child.updated' || adopted)
        return
      adopted = true
      const [edge] = await store.turnSpawnEdges.listChildren(parentTurnId)
      const child = await store.turns.read(edge!.childTurnId)

      submitted = engine.submit({
        ...turnRequest(child!.threadId, child!.id),
        input: () => {
          preparing.resolve()
          return input.promise
        },
      }, store).catch(error => ({ error }))
      await preparing.promise
    },
  })

  try {
    await seedParentTurn(store, 'thread-publication-parent', parentTurnId, ['tool-publication'])
    await engine.resume(resumableTurnRequest('thread-publication-parent', parentTurnId), store).completed
    const edges = await store.turnSpawnEdges.listChildren(parentTurnId)

    expect(edges).toHaveLength(1)
    expect(handle?.turnId).toBe(edges[0]?.childTurnId)
    expect(childInvocations).toBe(0)
    expect((await store.turns.read(parentTurnId))?.status).toBe('completed')
    expect((await store.turns.read(handle!.turnId))?.status).toBe('queued')
    expect(await store.canonical.list(handle!.threadId)).toHaveLength(1)

    input.resolve([])
    expect(await submitted).toMatchObject({
      threadId: handle!.threadId,
      turnId: handle!.turnId,
      status: expect.stringMatching(/^(queued|running)$/),
    })
    await waitForChildTurns(store, parentTurnId)
    expect(childInvocations).toBe(1)
    expect((await store.turns.read(handle!.turnId))?.status).toBe('completed')
  }
  finally {
    input.resolve([])
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('spawnSubagent persists one child and returns the same handle on retry', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    const handles: Array<{ threadId: string, turnId: string }> = []
    const events: RuntimeEvent[] = []
    const engine = createEngine(createAgent(async (options) => {
      if (!options.parentThreadId) {
        expect(options.subagentRole.id).toBe(testSubagentRole.id)
        const [first, second] = await Promise.all([
          options.testSubagents!.spawn({
            role: testSubagentRole.id,
            name: '调研任务',
            description: '检查子线程装配',
            ownerId: 'subagent',
            parentToolCallId: 'tool-parent',
          }),
          options.testSubagents!.spawn({
            role: testSubagentRole.id,
            name: '调研任务',
            description: '并发重试同一个工具调用',
            ownerId: 'subagent',
            parentToolCallId: 'tool-parent',
          }),
        ])

        handles.push(first, second)
        return completedTurnResult()
      }

      expect(options.testSubagents).toBeUndefined()
      expect(options.subagentRole.id).toBe(testSubagentRole.id)
      expect(options.parentThreadId).toBe('thread-parent')
      expect(options.subagentMode).toBe('explicitOnly')
      expect(options.model).toBe(turnModel)
      return completedTurnResult()
    }), {
      onRuntimeEvent: (_agentId, event) => {
        events.push(event)
      },
    })

    await engine.resume(resumableTurnRequest('thread-parent', testId('turn', 'parent')), store).completed

    expect(handles[0]?.threadId).toBe(handles[1]?.threadId)
    expect(handles[0]?.turnId).toBe(handles[1]?.turnId)
    const childMessages = await store.canonical.list(handles[0]!.threadId)
    const childMessage = await store.canonical.readMessage(
      handles[0]!.threadId,
      childMessages[0]!.id,
    )

    expect(childMessages).toHaveLength(1)
    expect(canonicalRecordToMessage(childMessage!)).toMatchObject({
      role: 'user',
      parts: [{
        type: 'text',
        text: expect.any(String),
      }],
    })
    expect(await store.spawnEdges.listChildren('thread-parent')).toHaveLength(1)
    expect((await store.spawnEdges.listChildren('thread-parent'))[0]?.ownerId).toBe('subagent')
    expect(await store.turnSpawnEdges.listChildren(testId('turn', 'parent'))).toHaveLength(1)
    expect(await store.turns.read(handles[0]!.turnId)).toMatchObject({
      subagentRole: testSubagentRole,
      subagentRoles: [],
      subagentMode: 'explicitOnly',
    })

    await waitForChildTurns(store, testId('turn', 'parent'))
    const subagentEvents = events.filter(event => event.type === 'thread.child.updated')

    expect((await store.threads.read('thread-parent'))?.unreadAt).toBeTypeOf('string')
    expect((await store.threads.read(handles[0]!.threadId))?.unreadAt).toBeNull()
    expect(subagentEvents.length).toBeGreaterThan(0)
    for (const event of subagentEvents) {
      expect(event.threadId).toBe('thread-parent')
      expect(event.turnId).toBeUndefined()
      expect(event.toolCallId).toBeUndefined()
      expect(event.payload).toMatchObject({
        ownerId: 'subagent',
        turnId: handles[0]!.turnId,
        parentToolCallId: 'tool-parent',
        title: '调研任务',
        data: {
          role: {
            id: testSubagentRole.id,
            name: testSubagentRole.name,
            icon: testSubagentRole.icon,
          },
        },
      })
    }
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('subagent event publication failure does not block child scheduling', async () => {
  const { root, store } = await createEngineStore()
  const originalWarn = console.warn
  const warnings: unknown[][] = []

  console.warn = (...args) => warnings.push(args)

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    let waitedStatus: string | undefined
    const engine = createEngine(createAgent(async (options) => {
      if (options.parentThreadId)
        return completedTurnResult()

      const child = await options.testSubagents!.spawn({
        role: testSubagentRole.id,
        name: '事件出口失败任务',
        description: '验证通知失败不阻断调度',
        ownerId: 'subagent',
        parentToolCallId: 'tool-parent',
      })
      const waited = await options.testSubagents!.wait({
        threadIds: [child.threadId],
        timeoutMs: 1_000,
      })

      waitedStatus = waited.subagents[0]?.status
      return completedTurnResult()
    }), {
      onRuntimeEvent: () => {
        throw new Error('模拟事件出口同步失败')
      },
    })

    await engine.resume(resumableTurnRequest('thread-parent', testId('turn', 'parent')), store).completed

    expect(waitedStatus).toBe('completed')
    expect(warnings.length).toBeGreaterThan(0)
    expect(await store.turnSpawnEdges.listChildren(testId('turn', 'parent'))).toHaveLength(1)
  }
  finally {
    console.warn = originalWarn
    await disposeEngineStore(root, store)
  }
})

test('spawnSubagent retry returns the persisted terminal status', async () => {
  const { root, store } = await createEngineStore()

  try {
    const toolCallIds = [
      'tool-completed',
      'tool-failed',
      'tool-cancelled',
    ]
    const replayedStatuses: string[] = []
    let childIndex = 0

    await seedParentTurn(store, 'thread-terminal-parent', testId('turn', 'terminal-parent'), toolCallIds)
    const engine = createEngine(createAgent(async (options) => {
      if (options.parentThreadId) {
        childIndex += 1

        if (childIndex === 1)
          return completedTurnResult()
        if (childIndex === 2)
          throw new Error('子任务失败')

        await new Promise<never>((_, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }

          options.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason)
          }, { once: true })
        })
      }

      for (const [index, parentToolCallId] of toolCallIds.entries()) {
        const request = {
          role: testSubagentRole.id,
          name: `终态任务 ${index + 1}`,
          description: `验证 ${parentToolCallId} 重放`,
          ownerId: 'subagent',
          parentToolCallId,
        }
        const spawned = await options.testSubagents!.spawn(request)

        if (parentToolCallId === 'tool-cancelled')
          await options.testSubagents!.interrupt(spawned.threadId)

        await options.testSubagents!.wait({
          threadIds: [spawned.threadId],
          timeoutMs: 1_000,
        })
        const replayed = await options.testSubagents!.spawn(request)

        replayedStatuses.push(replayed.status)
      }

      return completedTurnResult()
    }))

    await engine.resume(resumableTurnRequest(
      'thread-terminal-parent',
      testId('turn', 'terminal-parent'),
    ), store).completed
    await waitForChildTurns(store, testId('turn', 'terminal-parent'))

    expect(replayedStatuses).toEqual([
      'completed',
      'failed',
      'cancelled',
    ])
    const edges = await store.spawnEdges.listChildren('thread-terminal-parent')
    const children = await Promise.all(
      edges.map(edge => store.threads.read(edge.childThreadId)),
    )

    expect(edges).toHaveLength(3)
    expect(children.map(thread => thread?.unreadAt)).toEqual([null, null, null])
    expect(await store.turnSpawnEdges.listChildren(testId('turn', 'terminal-parent'))).toHaveLength(3)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('spawnSubagent transaction failure leaves no orphan child facts', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    const failingStore: RuntimeStore = {
      threads: store.threads,
      transcript: store.transcript,
      canonical: store.canonical,
      turns: store.turns,
      steps: store.steps,
      toolCalls: store.toolCalls,
      spawnEdges: store.spawnEdges,
      turnSpawnEdges: store.turnSpawnEdges,
      artifacts: store.artifacts,
      close: () => Promise.resolve(),
      transaction: fn => store.transaction((tx) => {
        const failingTx: RuntimeStoreTx = {
          ...tx,
          turnSpawnEdges: {
            ...tx.turnSpawnEdges,
            create: () => Promise.reject(new Error('派生关系写入失败')),
          },
        }

        return fn(failingTx)
      }),
    }
    const engine = createEngine(createAgent(async (options) => {
      await options.testSubagents!.spawn({
        role: testSubagentRole.id,
        name: '失败任务',
        description: '验证事务回滚',
        ownerId: 'subagent',
        parentToolCallId: 'tool-parent',
      })

      return completedTurnResult()
    }))

    await expect(engine.resume(resumableTurnRequest(
      'thread-parent',
      testId('turn', 'parent'),
    ), failingStore).completed)
      .rejects
      .toThrow('派生关系写入失败')

    expect(await store.spawnEdges.listChildren('thread-parent')).toEqual([])
    expect(await store.turnSpawnEdges.listChildren(testId('turn', 'parent'))).toEqual([])
    expect((await store.threads.listAll()).map(
      (thread: { id: string }) => thread.id,
    ))
      .toEqual(['thread-parent'])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('six submitted children use four slots and preserve FIFO order', async () => {
  const { root, store } = await createEngineStore()
  let release = () => {}
  let running: Promise<unknown> | undefined

  try {
    const toolIds = Array.from({ length: 6 }, (_, index) => `tool_${index}`)

    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), toolIds)

    let active = 0
    let completed = 0
    let fourActive!: () => void
    let allCompleted!: () => void
    let childrenSubmitted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reachedLimit = new Promise<void>((resolve) => {
      fourActive = resolve
    })
    const finished = new Promise<void>((resolve) => {
      allCompleted = resolve
    })
    const submitted = new Promise<void>((resolve) => {
      childrenSubmitted = resolve
    })
    const handles: Array<{ threadId: string, status: string }> = []
    const started: string[] = []
    const engine = createEngine(createAgent(async (options) => {
      if (!options.parentThreadId) {
        expect(options.subagentRole.id).toBe(testSubagentRole.id)
        for (const [index, toolCallId] of toolIds.entries()) {
          handles.push(await options.testSubagents!.spawn({
            role: testSubagentRole.id,
            name: `子任务 ${index}`,
            description: `验证 FIFO ${index}`,
            ownerId: 'subagent',
            parentToolCallId: toolCallId,
          }))
        }
        childrenSubmitted()

        return completedTurnResult()
      }

      started.push(options.threadId)
      active += 1

      if (active === 4)
        fourActive()

      await gate
      active -= 1
      completed += 1

      if (completed === 6)
        allCompleted()

      return completedTurnResult()
    }))

    running = engine.resume(resumableTurnRequest(
      'thread-parent',
      testId('turn', 'parent'),
    ), store).completed

    await Promise.all([reachedLimit, submitted])

    expect(active).toBe(4)
    expect(handles.every(handle => (
      handle.status === 'queued' || handle.status === 'running'
    ))).toBe(true)

    const children = await engine.listChildren({
      agentId: 'code',
      parentThreadId: 'thread-parent',
      store,
    })

    expect(children.filter(child => child.status === 'running')).toHaveLength(4)
    expect(children.filter(child => child.status === 'queued')).toHaveLength(2)

    release()
    await finished
    await running
    await waitForChildTurns(store, testId('turn', 'parent'))

    expect(started).toEqual(handles.map(handle => handle.threadId))
  }
  finally {
    release()
    await running?.catch(() => undefined)
    await disposeEngineStore(root, store)
  }
})

test('waitSubagent does not extend the parent Turn after one child returns', async () => {
  const { root, store } = await createEngineStore()
  let releaseFirst = () => {}
  let releaseSecond = () => {}

  try {
    await seedParentTurn(
      store,
      'thread-wait-parent',
      testId('turn', 'wait-parent'),
      ['tool-wait-first', 'tool-wait-second'],
    )

    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let childIndex = 0
    let childrenStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      childrenStarted = resolve
    })
    let waitReturned!: () => void
    const returned = new Promise<void>((resolve) => {
      waitReturned = resolve
    })
    let waitedSubagents: Array<{ status: string }> = []
    const engine = createEngine(createAgent(async (options) => {
      if (!options.parentThreadId) {
        const first = await options.testSubagents!.spawn({
          role: testSubagentRole.id,
          name: '先完成的任务',
          description: '验证 waitSubagent 任一完成即返回',
          ownerId: 'subagent',
          parentToolCallId: 'tool-wait-first',
        })
        const second = await options.testSubagents!.spawn({
          role: testSubagentRole.id,
          name: '仍在运行的任务',
          description: '验证 waitSubagent 返回全部当前状态',
          ownerId: 'subagent',
          parentToolCallId: 'tool-wait-second',
        })
        const waited = await options.testSubagents!.wait({
          threadIds: [first.threadId, second.threadId],
          timeoutMs: 5_000,
        })

        waitedSubagents = waited.subagents
        waitReturned()
        return completedTurnResult()
      }

      const index = childIndex++

      if (childIndex === 2)
        childrenStarted()

      await (index === 0 ? firstGate : secondGate)
      return completedTurnResult()
    }))
    const parentTurn = engine.resume(
      resumableTurnRequest('thread-wait-parent', testId('turn', 'wait-parent')),
      store,
    ).completed
    let parentSettled = false

    parentTurn.then(
      () => {
        parentSettled = true
      },
      () => undefined,
    )

    await bothStarted
    releaseFirst()
    await returned

    expect(waitedSubagents).toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'running' }),
    ])
    await parentTurn
    expect(parentSettled).toBe(true)

    releaseSecond()
    await waitForChildTurns(store, testId('turn', 'wait-parent'))
  }
  finally {
    releaseFirst()
    releaseSecond()
    await disposeEngineStore(root, store)
  }
})

test('aborting a root Turn cascades cancellation without the HTTP runner', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-one', 'tool-two'])
    let childrenSpawned!: () => void
    const spawned = new Promise<void>((resolve) => {
      childrenSpawned = resolve
    })
    const engine = createEngine(createAgent(async (options) => {
      if (!options.parentThreadId) {
        expect(options.subagentRole.id).toBe(testSubagentRole.id)
        await options.testSubagents!.spawn({
          role: testSubagentRole.id,
          name: '任务一',
          description: '由根 Turn 统一取消',
          ownerId: 'subagent',
          parentToolCallId: 'tool-one',
        })
        await options.testSubagents!.spawn({
          role: testSubagentRole.id,
          name: '任务二',
          description: '由根 Turn 统一取消',
          ownerId: 'subagent',
          parentToolCallId: 'tool-two',
        })
        childrenSpawned()
      }

      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(options.signal?.reason)

        if (options.signal?.aborted)
          abort()
        else
          options.signal?.addEventListener('abort', abort, { once: true })
      })

      return completedTurnResult()
    }))
    const controller = new AbortController()
    const running = engine.resume({
      ...resumableTurnRequest('thread-parent', testId('turn', 'parent')),
      signal: controller.signal,
    }, store).completed

    await spawned
    controller.abort('用户中断')
    await expect(running).rejects.toBe('用户中断')
    await waitForChildTurns(store, testId('turn', 'parent'))

    expect(await engine.listChildren({
      agentId: 'code',
      parentThreadId: 'thread-parent',
      store,
    })).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      expect.objectContaining({ status: 'cancelled' }),
    ])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('child identity remains subagent when resumed through the public Turn entry', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-child', metadata: {
      workspaceRoot: '/tmp/elmino-agent-engine',
      cwd: '/tmp/elmino-agent-engine',
      workspaceId: 'default',
    }, state: { contextProjection: {} } })
    await store.turns.create({
      id: testId('turn', 'child'),
      threadId: 'thread-child',
      subagentRole: testSubagentRole,
      subagentRoles: [],
      status: 'interrupted',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'request',
      subagentMode: 'explicitOnly',
    })
    await store.turns.update(testId('turn', 'child'), {
      interrupt: { ...testResumeInterrupt(testId('turn', 'child')) },
    })
    await store.spawnEdges.create({
      childThreadId: 'thread-child',
      ownerId: 'subagent',
      parentThreadId: 'thread-parent',
    })
    await store.turnSpawnEdges.create({
      childTurnId: testId('turn', 'child'),
      parentToolCallId: 'tool-parent',
    })
    const seen: TestTurnContext[] = []
    const engine = createEngine(createAgent((options) => {
      seen.push(options)
      return Promise.resolve(completedTurnResult())
    }))

    await engine.resume({
      ...resumableTurnRequest('thread-child', testId('turn', 'child')),
      agentId: 'code',
      approvalMode: 'request',
    }, store).completed

    expect(seen[0]?.subagentRole.id).toBe(testSubagentRole.id)
    expect(seen[0]?.parentThreadId).toBe('thread-parent')
    expect(seen[0]?.testSubagents).toBeUndefined()
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('waitSubagent reports child human interaction without interrupting the parent', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    let waitedStatus: string | undefined
    const engine = createEngine(createAgent(async (options) => {
      if (!options.parentThreadId) {
        expect(options.subagentRole.id).toBe(testSubagentRole.id)
        const handle = await options.testSubagents!.spawn({
          role: testSubagentRole.id,
          name: '需要确认',
          description: '等待子线程审批',
          ownerId: 'subagent',
          parentToolCallId: 'tool-parent',
        })
        const waited = await options.testSubagents!.wait({
          threadIds: [handle.threadId],
          timeoutMs: 5000,
        })

        waitedStatus = waited.subagents[0]?.status
        return completedTurnResult()
      }

      const now = dayjs().toISOString()
      const interrupt = {
        id: testId('interrupt', 'child'),
        kind: 'interaction',
        interaction: 'tool_approval',
        status: 'pending',
        turnId: options.turnId,
        reason: '等待审批',
        payload: {},
        createdAt: now,
        resumableWith: ['interaction'],
      } satisfies ThreadInterrupt

      return {
        outcome: {
          status: 'interrupted',
          interrupt,
        },
      }
    }))

    await engine.resume(resumableTurnRequest('thread-parent', testId('turn', 'parent')), store).completed

    expect(waitedStatus).toBe('waiting')
  }
  finally {
    await disposeEngineStore(root, store)
  }
})
