import type { AgentEngine } from '@elmino/engine'
import type { RuntimeStore, RuntimeStoreTx, ThreadMessage } from '@elmino/store'
import type { TestTurnContext } from './support/engine'
import { ContextProjection } from '@elmino/loop'
import { createId, delay } from '@elmino/shared'
import { appendCanonicalMessage, hydrateThreadMessages } from '@elmino/thread'
import { expect, test } from 'vitest'

import {
  completedTurnResult,
  createAgent,
  createEngine,
  createEngineStore,
  createTestThreadLocation,
  disposeEngineStore,
  seedParentTurn,
  testId,
  testSubagentRole,
  testSubagentRoles,
  turnModel,
  turnRequest,
  waitForChildTurns,
} from './support/engine'

/** -------------------- 测试 -------------------- */
test('Repeated recovery preserves five Child Turns already accepted by the same Engine', async () => {
  const { root, store } = await createEngineStore()
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const invoked: string[] = []
  let restores = 0
  const engine = createEngine(createAgent(async (context) => {
    invoked.push(context.turnId)
    if (invoked.length === 4)
      started.resolve()
    await proceed.promise
    return completedTurnResult()
  }), {
    restoreModel: () => {
      restores++
      return Promise.resolve(turnModel)
    },
  })

  try {
    const children = await createQueuedChildren(store, 'repeated-recovery', 5)
    const handles: Awaited<ReturnType<AgentEngine['submit']>>[] = []

    for (const child of children)
      handles.push(await engine.submit(turnRequest(child.threadId, child.turnId), store))
    expect(handles.map(handle => handle.status)).toEqual(['running', 'running', 'running', 'running', 'queued'])

    await started.promise
    const queued = children[4]!
    const originalQueued = await store.turns.read(queued.turnId)

    expect(originalQueued?.status).toBe('queued')
    await engine.recoverWorkspace({ agentId: 'code', store, threadLocation: createTestThreadLocation() })
    expect(restores).toBe(0)
    expect(await store.turns.read(queued.turnId)).toEqual(originalQueued)
    for (const child of children.slice(0, 4))
      expect((await store.turns.read(child.turnId))?.status).toBe('running')

    proceed.resolve()
    await waitForChildTurns(store, testId('turn', 'parent-repeated-recovery'))
    expect(invoked).toEqual(children.map(child => child.turnId))
    for (const child of children)
      expect((await store.turns.read(child.turnId))?.status).toBe('completed')
  }
  finally {
    proceed.resolve()
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('Recovery preserves a Child Turn while its accepted input supplier is still preparing', async () => {
  const { root, store } = await createEngineStore()
  const preparing = Promise.withResolvers<void>()
  const input = Promise.withResolvers<[]>()
  let restores = 0
  let invoked = 0
  const engine = createEngine(createAgent(() => {
    invoked++
    return Promise.resolve(completedTurnResult())
  }), {
    restoreModel: () => {
      restores++
      return Promise.resolve(turnModel)
    },
  })

  try {
    const [child] = await createQueuedChildren(store, 'preparing-recovery', 1)
    const submission = engine.submit({
      ...turnRequest(child!.threadId, child!.turnId),
      input: () => {
        preparing.resolve()
        return input.promise
      },
    }, store)

    await preparing.promise
    const original = await store.turns.read(child!.turnId)

    await engine.recoverWorkspace({ agentId: 'code', store, threadLocation: createTestThreadLocation() })
    expect(restores).toBe(0)
    expect(invoked).toBe(0)
    expect(await store.turns.read(child!.turnId)).toEqual(original)

    input.resolve([])
    await submission
    await waitForChildTurns(store, testId('turn', 'parent-preparing-recovery'))
    expect(invoked).toBe(1)
    expect((await store.turns.read(child!.turnId))?.status).toBe('completed')
  }
  finally {
    input.resolve([])
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test.each(['location', 'model', 'model-error'] as const)(
  'Recovery yields to a later accepted Child while awaiting %s',
  async (phase) => {
    const { root, store } = await createEngineStore()
    const recoveryWaiting = Promise.withResolvers<void>()
    const releaseRecovery = Promise.withResolvers<void>()
    const inputWaiting = Promise.withResolvers<void>()
    const input = Promise.withResolvers<[]>()
    let invoked = 0
    const engine = createEngine(createAgent(() => {
      invoked++
      return Promise.resolve(completedTurnResult())
    }), {
      restoreModel: async () => {
        if (phase !== 'location') {
          recoveryWaiting.resolve()
          await releaseRecovery.promise
        }
        if (phase === 'model-error')
          throw new Error('Recovery model restoration failed')
        return turnModel
      },
    })

    try {
      const [child] = await createQueuedChildren(store, `adopted-during-${phase}`, 1)
      const original = await store.turns.read(child!.turnId)
      const recovery = engine.recoverWorkspace({
        agentId: 'code',
        store,
        threadLocation: async (thread) => {
          if (phase === 'location') {
            recoveryWaiting.resolve()
            await releaseRecovery.promise
          }
          return createTestThreadLocation()(thread)
        },
      })

      await recoveryWaiting.promise
      const submission = engine.submit({
        ...turnRequest(child!.threadId, child!.turnId),
        input: () => {
          inputWaiting.resolve()
          return input.promise
        },
      }, store)

      const submitted = submission.catch(error => error)
      await inputWaiting.promise
      releaseRecovery.resolve()
      await recovery
      expect(await store.turns.read(child!.turnId)).toEqual(original)
      expect(invoked).toBe(0)

      input.resolve([])
      expect(await submitted).toMatchObject({ threadId: child!.threadId, turnId: child!.turnId })
      await waitForChildTurns(store, testId('turn', `parent-adopted-during-${phase}`))
      expect(invoked).toBe(1)
      expect((await store.turns.read(child!.turnId))?.status).toBe('completed')
    }
    finally {
      releaseRecovery.resolve()
      input.resolve([])
      await engine.close()
      await disposeEngineStore(root, store)
    }
  },
)

test('Orphan settlement yields to a Child accepted while its transaction is reading facts', async () => {
  const { root, store } = await createEngineStore()
  const reading = Promise.withResolvers<void>()
  const releaseReading = Promise.withResolvers<void>()
  const inputWaiting = Promise.withResolvers<void>()
  const input = Promise.withResolvers<[]>()
  const transaction = store.transaction.bind(store)
  let invoked = 0
  const engine = createEngine(createAgent(() => {
    invoked++
    return Promise.resolve(completedTurnResult())
  }))

  try {
    const [child] = await createQueuedChildren(store, 'adopted-during-settlement', 1)
    const original = await readChildFacts(store, child!.threadId, child!.turnId)
    let block = true

    store.transaction = callback => transaction(tx => callback({
      ...tx,
      threads: {
        ...tx.threads,
        read: async (id) => {
          const thread = await tx.threads.read(id)

          if (id === child!.threadId && block) {
            block = false
            reading.resolve()
            await releaseReading.promise
          }
          return thread
        },
      },
    }))
    const recovery = engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: createTestThreadLocation(),
      resumeQueuedChildren: false,
    })

    await reading.promise
    const submission = engine.submit({
      ...turnRequest(child!.threadId, child!.turnId),
      input: () => {
        inputWaiting.resolve()
        return input.promise
      },
    }, store)
    const submitted = submission.catch(error => error)

    await inputWaiting.promise
    releaseReading.resolve()
    await recovery
    expect(await readChildFacts(store, child!.threadId, child!.turnId)).toEqual(original)
    expect(invoked).toBe(0)

    store.transaction = transaction
    input.resolve([])
    expect(await submitted).toMatchObject({ threadId: child!.threadId, turnId: child!.turnId })
    await waitForChildTurns(store, testId('turn', 'parent-adopted-during-settlement'))
    expect(invoked).toBe(1)
    expect((await store.turns.read(child!.turnId))?.status).toBe('completed')
  }
  finally {
    releaseReading.resolve()
    input.resolve([])
    store.transaction = transaction
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('Recovery rolls back all settlement writes if a Child is accepted during its state reducer', async () => {
  const { root, store } = await createEngineStore()
  const reducing = Promise.withResolvers<void>()
  const releaseReducer = Promise.withResolvers<void>()
  const inputWaiting = Promise.withResolvers<void>()
  const input = Promise.withResolvers<[]>()
  let invoked = 0
  const engine = createEngine(createAgent(() => {
    invoked++
    return Promise.resolve(completedTurnResult())
  }, {
    settleState: async ({ status }) => {
      if (status !== 'interrupted')
        return undefined
      reducing.resolve()
      await releaseReducer.promise
      return { recovery: { type: 'replace', value: { discarded: true } } }
    },
  }))

  try {
    const [child] = await createQueuedChildren(store, 'adopted-during-reducer', 1)
    const original = await readChildFacts(store, child!.threadId, child!.turnId)
    const recovery = engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: createTestThreadLocation(),
      resumeQueuedChildren: false,
    })

    await reducing.promise
    const submission = engine.submit({
      ...turnRequest(child!.threadId, child!.turnId),
      input: () => {
        inputWaiting.resolve()
        return input.promise
      },
    }, store)
    const submitted = submission.catch(error => error)

    await inputWaiting.promise
    releaseReducer.resolve()
    await recovery
    expect(await readChildFacts(store, child!.threadId, child!.turnId)).toEqual(original)
    expect(invoked).toBe(0)

    input.resolve([])
    expect(await submitted).toMatchObject({ threadId: child!.threadId, turnId: child!.turnId })
    await waitForChildTurns(store, testId('turn', 'parent-adopted-during-reducer'))
    expect(invoked).toBe(1)
    expect((await store.turns.read(child!.turnId))?.status).toBe('completed')
    const state = (await store.threads.read(child!.threadId))!.state

    expect(state).not.toHaveProperty('extensionState.recovery')
    expect(state.extensionState).toEqual(original.thread?.state.extensionState)
  }
  finally {
    releaseReducer.resolve()
    input.resolve([])
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test.each(['sync', 'async'])('workspace recovery with %s callbacks resubmits queued children and interrupts orphaned Turns', async (mode) => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), [
      'tool-bad',
      'tool-queued',
      'tool-stale',
    ])

    for (const child of [
      { threadId: 'thread-bad', turnId: testId('turn', 'bad'), status: 'queued' as const, toolId: 'tool-bad' },
      { threadId: 'thread-queued', turnId: testId('turn', 'queued'), status: 'queued' as const, toolId: 'tool-queued' },
      { threadId: 'thread-stale', turnId: testId('turn', 'stale'), status: 'running' as const, toolId: 'tool-stale' },
    ]) {
      await store.threads.upsert({ dir: '.', agentId: 'code', id: child.threadId, status: child.status === 'queued' ? 'idle' : 'running', metadata: {
        workspaceRoot: '/tmp/elmino-agent-engine',
        cwd: '/tmp/elmino-agent-engine',
        workspaceId: 'default',
      }, state: { contextProjection: {} } })
      await store.turns.create({
        id: child.turnId,
        threadId: child.threadId,
        subagentRole: testSubagentRole,
        subagentRoles: [],
        status: child.status,
        modelConfig: child.turnId === testId('turn', 'bad')
          ? { ...turnModel.config, id: 'bad/model' }
          : { ...turnModel.config },
        agentSnapshot: { id: 'code', systemPrompt: '' },
        approvalMode: 'auto',
        subagentMode: 'explicitOnly',
      })
      await store.spawnEdges.create({
        childThreadId: child.threadId,
        ownerId: 'subagent',
        parentThreadId: 'thread-parent',
      })
      await store.turnSpawnEdges.create({
        childTurnId: child.turnId,
        parentToolCallId: child.toolId,
      })
    }
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-root-queued', status: 'idle', metadata: {
      workspaceRoot: '/tmp/elmino-agent-engine',
      cwd: '/tmp/elmino-agent-engine',
      workspaceId: 'default',
    }, state: { contextProjection: {} } })
    await store.turns.create({
      id: testId('turn', 'root-queued'),
      threadId: 'thread-root-queued',
      subagentRole: testSubagentRole,
      subagentRoles: [testSubagentRole],
      status: 'queued',
      modelConfig: { ...turnModel.config },
      agentSnapshot: { id: 'code', systemPrompt: '' },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    const staleStep = await store.steps.create({
      turnId: testId('turn', 'stale'),
      input: 120,
      estimated: 120,
    })
    const now = new Date().toISOString()
    const staleDraft = {
      id: createId('msg'),
      threadId: 'thread-stale',
      turnId: testId('turn', 'stale'),
      role: 'assistant',
      kind: 'normal',
      status: 'streaming',
      parts: [] as ThreadMessage['parts'],
      createdAt: now,
      updatedAt: now,
      metadata: {},
    } satisfies ThreadMessage
    const staleTextPart = {
      id: createId('part'),
      messageId: staleDraft.id,
      threadId: staleDraft.threadId,
      turnId: staleDraft.turnId,
      seq: 1,
      type: 'text',
      status: 'running',
      text: '服务崩溃前已经输出的正文',
      createdAt: now,
      updatedAt: now,
    } as const
    staleDraft.parts.push(staleTextPart)
    await store.transcript.upsert(staleDraft)
    const staleMessage = {
      id: createId('msg'),
      threadId: 'thread-stale',
      turnId: testId('turn', 'stale'),
      role: 'assistant',
      kind: 'normal',
      status: 'completed',
      parts: [] as ThreadMessage['parts'],
      createdAt: now,
      updatedAt: now,
      metadata: {},
    } satisfies ThreadMessage
    const staleToolPart = {
      id: createId('part'),
      messageId: staleMessage.id,
      threadId: staleMessage.threadId,
      turnId: staleMessage.turnId,
      seq: 1,
      type: 'tool',
      status: 'running',
      toolName: 'shell',
      args: { command: 'pwd' },
      createdAt: now,
      updatedAt: now,
    } as const
    const completedToolPart = {
      id: createId('part'),
      messageId: staleMessage.id,
      threadId: staleMessage.threadId,
      turnId: staleMessage.turnId,
      seq: 2,
      type: 'tool',
      status: 'completed',
      toolName: 'shell',
      args: { command: 'date' },
      createdAt: now,
      updatedAt: now,
    } as const

    staleMessage.parts.push(staleToolPart, completedToolPart)
    await store.transcript.upsert(staleMessage)

    await store.toolCalls.create({
      id: 'tool-stale-running',
      turnId: testId('turn', 'stale'),
      assistantMessageId: staleMessage.id,
      assistantPartId: staleToolPart.id,
      providerCallId: 'toolu_stale_running',
      name: 'shell',
      args: { command: 'pwd' },
      status: 'running',
    })
    const completedTool = await store.toolCalls.create({
      id: 'tool-stale-completed',
      turnId: testId('turn', 'stale'),
      assistantMessageId: staleMessage.id,
      assistantPartId: completedToolPart.id,
      providerCallId: 'toolu_stale_completed',
      name: 'shell',
      args: { command: 'date' },
      status: 'completed',
    })
    const completedResultPartId = createId('canonical_part')

    await store.transaction(async (tx) => {
      await appendCanonicalMessage(tx, {
        threadId: 'thread-stale',
        turnId: testId('turn', 'stale'),
        message: {
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              id: 'toolu_stale_running',
              name: 'shell',
              args: { command: 'pwd' },
            },
            {
              type: 'tool-call',
              id: 'toolu_stale_completed',
              name: 'shell',
              args: { command: 'date' },
            },
          ],
        },
      })
      await appendCanonicalMessage(tx, {
        threadId: 'thread-stale',
        turnId: testId('turn', 'stale'),
        message: {
          role: 'tool',
          parts: [{
            type: 'tool-result',
            callId: 'toolu_stale_completed',
            name: 'shell',
            result: '副作用已发生但结果尚未写回上下文',
          }],
        },
        partIds: [completedResultPartId],
      })
      await tx.toolCalls.update(completedTool.id, {
        resultPartId: completedResultPartId,
      })
    })

    const invoked: string[] = []
    const recoveredDirs: string[] = []
    const engine = createEngine(createAgent((options) => {
      invoked.push(options.turnId)
      recoveredDirs.push(options.location.cwd)

      return Promise.resolve(completedTurnResult())
    }), {
      restoreModel: (config) => {
        if (config.id === 'bad/model') {
          if (mode === 'sync')
            throw new Error('模型配置已失效')
          return Promise.reject(new Error('模型配置已失效'))
        }
        return mode === 'sync' ? turnModel : Promise.resolve(turnModel)
      },
    })

    await engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: (thread) => {
        const location = createTestThreadLocation('/tmp/elmino-agent-engine-relinked')(thread)
        return mode === 'sync' ? location : Promise.resolve(location)
      },
    })
    await waitForChildTurns(store, testId('turn', 'parent'))

    expect(invoked).toEqual([testId('turn', 'queued')])
    expect(recoveredDirs).toEqual(['/tmp/elmino-agent-engine-relinked'])
    expect(await store.turns.list('thread-bad')).toContainEqual(expect.objectContaining({
      id: testId('turn', 'bad'),
      status: 'failed',
      errorMessage: '模型配置已失效',
    }))
    expect(await store.turns.list('thread-queued')).toContainEqual(expect.objectContaining({
      id: testId('turn', 'queued'),
      status: 'completed',
    }))
    expect(await store.turns.list('thread-stale')).toContainEqual(expect.objectContaining({
      id: testId('turn', 'stale'),
      status: 'interrupted',
      errorMessage: '服务重启中断了未完成的运行',
      interrupt: expect.objectContaining({ kind: 'system' }),
    }))
    expect(await store.threads.read('thread-stale')).toMatchObject({
      status: 'interrupted',
    })
    expect(await store.steps.list(testId('turn', 'stale'))).toContainEqual(
      expect.objectContaining({
        id: staleStep.id,
        status: 'interrupted',
        input: 120,
        estimated: 120,
      }),
    )
    expect(await store.transcript.list('thread-stale')).toHaveLength(2)
    const recoveredMessages = await hydrateThreadMessages({
      store,
      threadId: 'thread-stale',
    })
    expect(recoveredMessages.find(message => message.id === staleDraft.id)).toMatchObject({
      status: 'interrupted',
    })
    expect(recoveredMessages.flatMap(message => message.parts).find(part => (
      part.id === staleTextPart.id
    ))).toMatchObject({
      status: 'completed',
      text: '服务崩溃前已经输出的正文',
    })
    expect(recoveredMessages.flatMap(message => message.parts).find(part => (
      part.id === staleToolPart.id
    ))).toMatchObject({
      status: 'failed',
    })
    expect(recoveredMessages.flatMap(message => message.parts).find(part => (
      part.id === completedToolPart.id
    ))).toMatchObject({
      status: 'completed',
    })
    expect(await store.toolCalls.list({ turnId: testId('turn', 'stale') }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'tool-stale-running',
          status: 'failed',
          errorMessage: '服务重启中断了未完成的运行',
        }),
        expect.objectContaining({
          id: 'tool-stale-completed',
          status: 'completed',
          resultPartId: completedResultPartId,
        }),
      ]))
    const projection = ContextProjection.create({
      store,
      threadId: 'thread-stale',
      model: turnModel,
      state: {},
    })

    expect(await projection.project()).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            id: 'toolu_stale_running',
            name: 'shell',
            args: { command: 'pwd' },
          },
          {
            type: 'tool-call',
            id: 'toolu_stale_completed',
            name: 'shell',
            args: { command: 'date' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool-result',
            callId: 'toolu_stale_running',
            name: 'shell',
            result: '服务重启中断了未完成的运行',
            error: true,
          },
          {
            type: 'tool-result',
            callId: 'toolu_stale_completed',
            name: 'shell',
            result: '副作用已发生但结果尚未写回上下文',
          },
        ],
      },
    ])
    expect(await store.turns.read(testId('turn', 'root-queued'))).toMatchObject({
      status: 'interrupted',
      errorMessage: '服务重启中断了未完成的运行',
      interrupt: expect.objectContaining({ kind: 'system' }),
    })
    expect(await store.threads.read('thread-root-queued')).toMatchObject({
      status: 'interrupted',
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine close interrupts and drains a recovered background Child Turn', async () => {
  const { root, store } = await createEngineStore()
  let releaseChild = () => {}

  try {
    await seedParentTurn(
      store,
      'thread-parent-close',
      testId('turn', 'parent-close'),
      ['tool-child-close'],
    )
    await store.threads.upsert({
      dir: '.',
      agentId: 'code',
      id: 'thread-child-close',
      status: 'idle',
      state: { contextProjection: {} },
    })
    await store.turns.create({
      id: testId('turn', 'child-close'),
      threadId: 'thread-child-close',
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      status: 'queued',
      modelConfig: { ...turnModel.config },
      agentSnapshot: {
        id: 'code',
        systemPrompt: '',

      },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    await store.spawnEdges.create({
      childThreadId: 'thread-child-close',
      ownerId: 'subagent',
      parentThreadId: 'thread-parent-close',
    })
    await store.turnSpawnEdges.create({
      childTurnId: testId('turn', 'child-close'),
      parentToolCallId: 'tool-child-close',
    })

    let markChildStarted!: (context: TestTurnContext) => void
    const childStarted = new Promise<TestTurnContext>((resolve) => {
      markChildStarted = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    const engine = createEngine(createAgent(async (context) => {
      markChildStarted(context)
      // 模拟不响应取消的 Provider
      await childGate

      return completedTurnResult()
    }), {
      restoreModel: () => Promise.resolve(turnModel),
    })

    await engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: createTestThreadLocation(),
    })
    const childContext = await childStarted

    if (!childContext.signal)
      throw new Error('恢复 Child 缺少 Engine 取消信号')

    const closing = engine.close()
    let closed = false

    closing.then(
      () => {
        closed = true
      },
      () => undefined,
    )
    await Promise.resolve()

    expect(childContext.signal.aborted).toBe(true)
    expect(closed).toBe(false)
    expect(await store.turns.read(testId('turn', 'child-close'))).toMatchObject({
      status: 'running',
    })

    releaseChild()
    await closing

    expect(await store.turns.read(testId('turn', 'child-close'))).toMatchObject({
      status: 'interrupted',
      errorMessage: 'AgentEngine 正在关闭',
      interrupt: {
        kind: 'system',
        turnId: testId('turn', 'child-close'),
      },
    })
    await expect(engine.run(
      turnRequest('thread-after-close', testId('turn', 'after-close')),
      store,
    ).completed).rejects.toThrow('AgentEngine 正在关闭')
    expect(await store.threads.read('thread-after-close')).toBeUndefined()
    expect(engine.close()).toBe(closing)
  }
  finally {
    releaseChild()
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine close drains recovered Child Turns beyond the scheduler limit without invoking Provider', async () => {
  const { root, store } = await createEngineStore()
  let releaseRunning = () => {}
  let engine: AgentEngine | undefined

  try {
    const parentThreadId = 'thread-parent-close-queue'
    const parentTurnId = testId('turn', 'parent-close-queue')
    const children = Array.from({ length: 5 }, (_, index) => ({
      threadId: `thread-child-close-${index}`,
      turnId: testId('turn', `child-close-${index}`),
      toolCallId: `tool-child-close-${index}`,
    }))

    await seedParentTurn(
      store,
      parentThreadId,
      parentTurnId,
      children.map(child => child.toolCallId),
    )

    for (const child of children) {
      await store.threads.upsert({
        dir: '.',
        agentId: 'code',
        id: child.threadId,
        status: 'idle',
        state: { contextProjection: {} },
      })
      await store.turns.create({
        id: child.turnId,
        threadId: child.threadId,
        subagentRole: testSubagentRole,
        subagentRoles: testSubagentRoles,
        status: 'queued',
        modelConfig: { ...turnModel.config },
        agentSnapshot: {
          id: 'code',
          systemPrompt: '',

        },
        approvalMode: 'auto',
        subagentMode: 'explicitOnly',
      })
      await store.spawnEdges.create({
        childThreadId: child.threadId,
        ownerId: 'subagent',
        parentThreadId,
      })
      await store.turnSpawnEdges.create({
        childTurnId: child.turnId,
        parentToolCallId: child.toolCallId,
      })
    }

    let markRunningStarted!: (contexts: TestTurnContext[]) => void
    const runningStarted = new Promise<TestTurnContext[]>((resolve) => {
      markRunningStarted = resolve
    })
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve
    })
    const providerTurnIds: string[] = []
    const runningContexts: TestTurnContext[] = []

    engine = createEngine(createAgent(async (context) => {
      providerTurnIds.push(context.turnId)

      if (!children.slice(0, 4).some(child => child.turnId === context.turnId))
        throw new Error('关闭后排队 Child 不应调用 Provider')

      runningContexts.push(context)
      if (runningContexts.length === 4)
        markRunningStarted(runningContexts)
      await runningGate

      return completedTurnResult()
    }), {
      restoreModel: () => Promise.resolve(turnModel),
    })

    await engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: createTestThreadLocation(),
    })
    const contexts = await runningStarted

    if (contexts.some(context => !context.signal))
      throw new Error('恢复中的 Child 缺少 Engine 取消信号')

    const closing = engine.close()

    expect(contexts.every(context => context.signal?.aborted)).toBe(true)
    expect(providerTurnIds).toEqual(children.slice(0, 4).map(child => child.turnId))

    releaseRunning()
    await Promise.race([
      closing,
      delay(2_000).then(() => {
        throw new Error('AgentEngine 关闭等待排队 Child 超时')
      }),
    ])

    expect(providerTurnIds).toEqual(children.slice(0, 4).map(child => child.turnId))
    for (const child of children) {
      expect(await store.turns.read(child.turnId)).toMatchObject({
        status: 'interrupted',
        errorMessage: 'AgentEngine 正在关闭',
      })
    }
  }
  finally {
    releaseRunning()
    await engine?.close()
    await disposeEngineStore(root, store)
  }
})

test('workspace recovery interrupts queued children when the physical workspace is unavailable', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-child'])
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-child', status: 'idle', metadata: {
      workspaceRoot: '/tmp/elmino-agent-engine-missing',
      cwd: '/tmp/elmino-agent-engine-missing',
      workspaceId: 'default',
    }, state: { contextProjection: {} } })
    await store.turns.create({
      id: testId('turn', 'child'),
      threadId: 'thread-child',
      subagentRole: testSubagentRole,
      subagentRoles: testSubagentRoles,
      status: 'queued',
      modelConfig: { ...turnModel.config },
      agentSnapshot: {
        id: 'code',
        systemPrompt: '',

      },
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
      parentToolCallId: 'tool-child',
    })
    const invoked: string[] = []
    const engine = createEngine(createAgent((options) => {
      invoked.push(options.turnId)

      return Promise.resolve(completedTurnResult())
    }), {
      restoreModel: () => Promise.resolve(turnModel),
    })

    await engine.recoverWorkspace({
      agentId: 'code',
      store,
      threadLocation: createTestThreadLocation(
        '/tmp/elmino-agent-engine-missing',
      ),
      resumeQueuedChildren: false,
    })

    expect(invoked).toEqual([])
    expect(await store.turns.read(testId('turn', 'child'))).toMatchObject({
      status: 'interrupted',
      errorMessage: '服务重启中断了未完成的运行',
    })
    expect(await store.threads.read('thread-child')).toMatchObject({
      status: 'interrupted',
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('stale Turn recovery rolls back Turn facts when tool cleanup fails', async () => {
  const { root, store } = await createEngineStore()

  try {
    await seedParentTurn(store, 'thread-parent', testId('turn', 'parent'), ['tool-parent'])
    await store.threads.upsert({ dir: '.', agentId: 'code', id: 'thread-child', status: 'running', state: { contextProjection: {} } })
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
    const createdAt = new Date().toISOString()
    const message = {
      id: createId('msg'),
      threadId: 'thread-child',
      turnId: testId('turn', 'child'),
      role: 'assistant',
      kind: 'normal',
      status: 'streaming',
      parts: [] as ThreadMessage['parts'],
      createdAt,
      updatedAt: createdAt,
      metadata: {},
    } satisfies ThreadMessage
    const part = {
      id: createId('part'),
      messageId: message.id,
      threadId: message.threadId,
      turnId: message.turnId,
      seq: 1,
      type: 'tool',
      status: 'running',
      toolName: 'shell',
      args: { command: 'pwd' },
      createdAt,
      updatedAt: createdAt,
    } as const

    message.parts.push(part)
    await store.transcript.upsert(message)

    await store.toolCalls.create({
      id: 'tool-child',
      turnId: testId('turn', 'child'),
      assistantMessageId: message.id,
      assistantPartId: part.id,
      providerCallId: 'toolu_child',
      name: 'shell',
      args: { command: 'pwd' },
      status: 'running',
    })
    const step = await store.steps.create({
      turnId: testId('turn', 'child'),
      input: 80,
      estimated: 80,
    })

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
          toolCalls: {
            ...tx.toolCalls,
            update: () => Promise.reject(new Error('工具结算失败')),
          },
        }

        return fn(failingTx)
      }),
    }
    const engine = createEngine(createAgent(
      () => Promise.resolve(completedTurnResult()),
    ))

    await expect(engine.recoverWorkspace({
      agentId: 'code',
      store: failingStore,
      threadLocation: createTestThreadLocation(),
    })).rejects.toThrow('工具结算失败')

    expect(await store.turns.read(testId('turn', 'child'))).toMatchObject({ status: 'running' })
    expect((await store.toolCalls.list({ turnId: testId('turn', 'child') }))[0]).toMatchObject({
      status: 'running',
    })
    expect((await store.transcript.list('thread-child'))[0]?.parts[0]).toMatchObject({ status: 'running' })
    expect(await store.steps.list(testId('turn', 'child'))).toContainEqual(
      expect.objectContaining({ id: step.id, status: 'running' }),
    )
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

/** -------------------- 辅助函数 -------------------- */
/**
 * 为进程内恢复竞态创建真实父工具、派生边和待执行子 Turn
 */
async function createQueuedChildren(store: RuntimeStore, label: string, count: number) {
  const parentThreadId = `thread-parent-${label}`
  const parentTurnId = testId('turn', `parent-${label}`)
  const children = Array.from({ length: count }, (_, index) => ({
    threadId: `thread-child-${label}-${index}`,
    turnId: testId('turn', `child-${label}-${index}`),
    toolCallId: createId('tool'),
  }))

  await seedParentTurn(store, parentThreadId, parentTurnId, children.map(child => child.toolCallId))
  for (const child of children) {
    await store.threads.upsert({ id: child.threadId, agentId: 'code', dir: '.', status: 'idle' })
    await store.turns.create({
      id: child.turnId,
      threadId: child.threadId,
      status: 'queued',
      modelConfig: { ...turnModel.config },
      subagentRole: testSubagentRole,
      subagentRoles: [],
      agentSnapshot: { id: 'code', systemPrompt: 'test' },
      approvalMode: 'auto',
      subagentMode: 'explicitOnly',
    })
    await store.spawnEdges.create({ childThreadId: child.threadId, ownerId: 'subagent', parentThreadId })
    await store.turnSpawnEdges.create({ childTurnId: child.turnId, parentToolCallId: child.toolCallId })
  }
  return children
}

/**
 * 读取恢复事务可能更新的全部子线程事实，用完整数据核对事务回滚
 */
async function readChildFacts(store: RuntimeStore, threadId: string, turnId: string) {
  return {
    thread: await store.threads.read(threadId),
    turn: await store.turns.read(turnId),
    steps: await store.steps.list(turnId),
    tools: await store.toolCalls.list({ turnId }),
    transcript: await store.transcript.list(threadId),
    canonical: await store.canonical.list(threadId),
    canonicalParts: await store.canonical.listParts(threadId),
  }
}
