import type { ThreadMessage, ThreadPart } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { createRuntimeEvent } from '@elmino/thread'
import dayjs from 'dayjs'
import { expect, onTestFinished, test, vi } from 'vitest'
import { TurnControlRegistry } from '../src/engine/control'

import {
  completedTurnResult,
  createAgent,
  createEngine,
  createEngineStore,
  createTestRuntime,
  disposeEngineStore,
  posixTest,
  testId,
  turnRequest,
} from './support/engine'
import { waitForProcessExit } from './support/process'
import { createTestSandbox } from './support/sandbox'

/** -------------------- 测试 -------------------- */
test('Steering submitted before the final Step closes keeps its synchronous acceptance', async () => {
  const { root, store } = await createEngineStore()
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const texts: string[] = []
  const turnId = testId('turn', 'steering-at-step-close')
  const threadId = 'thread-steering-at-step-close'
  const engine = createEngine(createAgent(async (context) => {
    started.resolve()
    await proceed.promise
    const accepted = await context.steering!.afterStep('completed')

    texts.push(...accepted.flatMap(item => item.message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])))
    return completedTurnResult()
  }))

  try {
    const running = engine.run(turnRequest(threadId, turnId), store).completed

    await started.promise
    const steering = Promise.all([
      engine.steer({ agentId: 'code', threadId, turnId, store, text: 'First accepted before close' }),
      engine.steer({ agentId: 'code', threadId, turnId, store, text: 'Second accepted before close' }),
    ])
    const checked = expect(steering).resolves.toMatchObject([{ turnId }, { turnId }])

    proceed.resolve()
    await Promise.all([checked, running])
    expect(texts).toEqual(['First accepted before close', 'Second accepted before close'])
    const parts = (await store.transcript.list(threadId)).flatMap(message => message.parts)

    expect(parts).toHaveLength(2)
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'First accepted before close' }),
      expect.objectContaining({ type: 'text', text: 'Second accepted before close' }),
    ]))
  }
  finally {
    proceed.resolve()
    await engine.close()
    await disposeEngineStore(root, store)
  }
})

test('TurnControlRegistry rejects an interrupt after Turn settlement starts', async () => {
  const { root, store } = await createEngineStore()

  onTestFinished(() => disposeEngineStore(root, store))
  const turns = TurnControlRegistry.create()
  const threadId = 'thread-settling-interrupt'
  const turnId = testId('turn', 'settling-interrupt')
  const control = turns.start({ threadId, turnId }, { agentId: 'code', store })

  await expect(turns.beginSettlement(control)).resolves.toBe(true)
  expect(turns.interrupt(
    threadId,
    '过晚的中断',
    turnId,
  )).toBeUndefined()
  expect(control.controller.signal.aborted).toBe(false)
})

test('TurnControlRegistry consumes accepted steering in FIFO order and closes an empty terminal boundary', async () => {
  const { root, store } = await createEngineStore()

  onTestFinished(() => disposeEngineStore(root, store))
  const turns = TurnControlRegistry.create()
  const threadId = createId('thread')
  const turnId = createId('turn')
  const control = turns.start({ threadId, turnId }, { agentId: 'code', store })
  const input = (text: string) => ({
    message: { role: 'user' as const, parts: [{ type: 'text' as const, text }] },
  })

  const firstPending = Promise.withResolvers<ReturnType<typeof input>>()
  const first = turns.steer(threadId, turnId, () => firstPending.promise)
  const consumed = turns.afterStep(control, 'completed')
  const second = turns.steer(threadId, turnId, () => Promise.resolve(input('第二条')))

  firstPending.resolve(input('第一条'))

  await expect(consumed).resolves.toEqual([
    input('第一条'),
    input('第二条'),
  ])
  await Promise.all([first, second])
  await turns.steer(threadId, turnId, () => Promise.resolve(input('后续引导')))
  await expect(turns.afterStep(control, 'completed')).resolves.toEqual([input('后续引导')])
  await expect(turns.afterStep(control, 'completed')).resolves.toEqual([])
  expect(() => turns.steer(
    threadId,
    turnId,
    () => Promise.resolve(input('过晚消息')),
  )).toThrow('目标运行已结束或正在结算')
})

test.each(['failed', 'interrupted'] as const)('TurnControlRegistry 在 %s 边界关闭入口并等待已接纳持久化', async (status) => {
  const { root, store } = await createEngineStore()

  onTestFinished(() => disposeEngineStore(root, store))
  const turns = TurnControlRegistry.create()
  const threadId = createId('thread')
  const turnId = createId('turn')
  const control = turns.start({ threadId, turnId }, { agentId: 'code', store })
  const input = { message: { role: 'user' as const, parts: [{ type: 'text' as const, text: '已接纳' }] } }
  const pending = Promise.withResolvers<typeof input>()
  const accepted = turns.steer(threadId, turnId, () => pending.promise)

  await expect(turns.afterStep(control, status)).resolves.toEqual([])
  expect(() => turns.steer(threadId, turnId, () => pending.promise)).toThrow('目标运行已结束或正在结算')
  const settled = vi.fn()
  const settlement = turns.beginSettlement(control).then(settled)

  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  pending.resolve(input)
  await accepted
  await settlement
  expect(settled).toHaveBeenCalledWith(true)
})

test.each(['成功', '同步异常', '异步拒绝'] as const)('AgentEngine 引导通知%s时保持消息持久化与消费', async (mode) => {
  const { root, store } = await createEngineStore()
  const threadId = 'thread-steering-persistence'
  const turnId = testId('turn', 'steering-persistence')
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const accepted: string[] = []
  const events: RuntimeEvent[] = []
  const notificationError = new Error('模拟通知失败')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const agent = createAgent(async (options) => {
    started.resolve()
    await proceed.promise
    const messages = await options.steering!.afterStep('completed')

    accepted.push(...messages.flatMap(message => (
      message.message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])
    )))
    return completedTurnResult()
  })
  const engine = createEngine(agent, {
    onRuntimeEvent: (_agentId, event) => {
      events.push(event)
      if (event.type === 'message.updated') {
        if (mode === '同步异常')
          throw notificationError
        if (mode === '异步拒绝')
          return Promise.reject(notificationError)
      }
      return undefined
    },
  })

  try {
    const running = engine.run(turnRequest(threadId, turnId), store).completed

    await started.promise
    const steered = await engine.steer({
      agentId: 'code',
      threadId,
      turnId,
      text: '补充引导',
      store,
    })

    proceed.resolve()
    await running

    expect(accepted).toEqual(['补充引导'])
    expect(await store.transcript.list(threadId)).toEqual([
      expect.objectContaining({
        id: steered.messageId,
        role: 'user',
        turnId,
        parts: [expect.objectContaining({ type: 'text', text: '补充引导' })],
      }),
    ])
    expect(await store.canonical.list(threadId)).toEqual([
      expect.objectContaining({ role: 'user', turnId }),
    ])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.updated',
      messageId: steered.messageId,
      threadId,
      turnId,
    }))
    expect(warn).toHaveBeenCalledTimes(mode === '成功' ? 0 : 1)
    if (mode !== '成功')
      expect(warn).toHaveBeenCalledWith('引导消息事件发布失败', notificationError)
  }
  finally {
    warn.mockRestore()
    proceed.resolve()
    await disposeEngineStore(root, store)
  }
})

test('TurnControlRegistry preserves continuation prefixes when merging live deltas', () => {
  const turns = TurnControlRegistry.create()
  const threadId = createId('thread')
  const turnId = createId('turn')
  const messageId = createId('msg')
  const partId = createId('part')
  const createdAt = dayjs().toISOString()
  const part: ThreadPart = {
    id: partId,
    messageId,
    threadId,
    turnId,
    seq: 1,
    type: 'text',
    status: 'running',
    text: '前缀',
    createdAt,
    updatedAt: createdAt,
  }
  const message: ThreadMessage = {
    id: messageId,
    threadId,
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    parts: [{ ...part, text: '前缀新增' }],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  }

  turns.applyEvent(createRuntimeEvent({
    type: 'message.part.updated',
    threadId,
    turnId,
    messageId,
    partId,
    payload: { part },
  }))
  turns.applyEvent(createRuntimeEvent({
    type: 'message.part.delta',
    threadId,
    turnId,
    messageId,
    partId,
    payload: { delta: { text: '新增' } },
  }))

  expect(turns.mergeThreadMessages(threadId, [message])[0]?.parts[0])
    .toMatchObject({ text: '前缀新增' })
})

test('AgentEngine rejects a second active Turn for the same Thread', async () => {
  const { root, store } = await createEngineStore()
  let releaseFirst = () => {}
  let first: Promise<unknown> | undefined

  try {
    let markStarted!: () => void
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const engine = createEngine(createAgent(async () => {
      markStarted()
      await firstPending
      return completedTurnResult()
    }))
    first = engine.run(turnRequest('thread-exclusive', testId('turn', 'first')), store).completed

    await firstStarted

    await expect(engine.run(turnRequest('thread-exclusive', testId('turn', 'second')), store).completed)
      .rejects
      .toThrow(`线程 thread-exclusive 已在运行: ${testId('turn', 'first')}`)
    releaseFirst()
    await first
  }
  finally {
    releaseFirst()
    await first?.catch(() => undefined)
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine rejects a concurrent Turn before resolving its input', async () => {
  const { root, store } = await createEngineStore()
  let releaseInput = () => {}
  let first: Promise<unknown> | undefined

  try {
    let markInputStarted!: () => void
    const inputPending = new Promise<void>((resolve) => {
      releaseInput = resolve
    })
    const inputStarted = new Promise<void>((resolve) => {
      markInputStarted = resolve
    })
    const engine = createEngine(createAgent(
      () => Promise.resolve(completedTurnResult()),
    ))
    first = engine.run({
      ...turnRequest('thread-preparing', testId('turn', 'first')),
      input: async () => {
        markInputStarted()
        await inputPending
        return []
      },
    }, store).completed

    await inputStarted

    let secondInputResolved = false

    await expect(engine.run({
      ...turnRequest('thread-preparing', testId('turn', 'second')),
      input: () => {
        secondInputResolved = true
        return Promise.resolve([])
      },
    }, store).completed).rejects.toThrow(
      `线程 thread-preparing 已在运行: ${testId('turn', 'first')}`,
    )
    expect(secondInputResolved).toBe(false)

    releaseInput()
    await first
  }
  finally {
    releaseInput()
    await first?.catch(() => undefined)
    await disposeEngineStore(root, store)
  }
})

test('thread closing waits for an input supplier that already owns a reservation', async () => {
  const { root, store } = await createEngineStore()
  let releaseInput = () => {}
  let running: Promise<unknown> | undefined

  try {
    let markInputStarted!: () => void
    const inputPending = new Promise<void>((resolve) => {
      releaseInput = resolve
    })
    const inputStarted = new Promise<void>((resolve) => {
      markInputStarted = resolve
    })
    const engine = createEngine(createAgent(
      () => Promise.resolve(completedTurnResult()),
    ))

    running = engine.run({
      ...turnRequest('thread-closing-preparation', testId('turn', 'closing-preparation')),
      input: async () => {
        markInputStarted()
        await inputPending
        return []
      },
    }, store).completed
    await inputStarted

    const closing = engine.beginThreadClose('thread-closing-preparation')
    let closed = false

    closing.then(
      () => {
        closed = true
      },
      () => undefined,
    )
    await Promise.resolve()
    expect(closed).toBe(false)

    releaseInput()
    await closing
    expect(closed).toBe(true)
    await running
  }
  finally {
    releaseInput()
    await running?.catch(() => undefined)
    await disposeEngineStore(root, store)
  }
})

test('thread closing fence rejects every later public Turn entry', async () => {
  const { root, store } = await createEngineStore()

  try {
    let inputResolved = false
    const engine = createEngine(createAgent(() => {
      throw new Error('关闭线程不应调用 Agent')
    }))
    await engine.beginThreadClose('thread-closing')

    await expect(engine.run({
      ...turnRequest('thread-closing', testId('turn', 'run')),
      input: () => {
        inputResolved = true
        return Promise.resolve([])
      },
    }, store).completed)
      .rejects
      .toThrow('线程 thread-closing 正在删除')
    await expect(engine.submit(turnRequest('thread-closing', testId('turn', 'submit')), store))
      .rejects
      .toThrow('线程 thread-closing 正在删除')
    await expect(engine.resume(turnRequest('thread-closing', testId('turn', 'resume')), store).completed)
      .rejects
      .toThrow('线程 thread-closing 正在删除')
    expect(inputResolved).toBe(false)
    expect(await store.threads.read('thread-closing')).toBeUndefined()
    expect(await store.turns.list('thread-closing')).toEqual([])
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('AgentEngine interrupt waits for the exact Turn coroutine before returning', async () => {
  const { root, store } = await createEngineStore()

  try {
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const engine = createEngine(createAgent(async () => {
      markStarted()
      await gate
      return completedTurnResult()
    }))
    const running = engine.run(turnRequest('thread-wait', testId('turn', 'wait')), store).completed

    await started
    let waited = false
    const waiting = engine.interrupt({
      agentId: 'code',
      threadId: 'thread-wait',
      store,
      reason: '用户中断',
    }).then(() => {
      waited = true
    })

    await Promise.resolve()
    expect(waited).toBe(false)

    release()
    await expect(running).rejects.toThrow('用户中断')
    await waiting
    expect(waited).toBe(true)
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('a late interrupt waits for the settling Turn without falling back to Child cancellation', async () => {
  const { root, store } = await createEngineStore()
  let releaseTurn = () => {}
  let releaseSettlement = () => {}

  try {
    let markStarted!: () => void
    let markSettlementStarted!: () => void
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const settlementStarted = new Promise<void>((resolve) => {
      markSettlementStarted = resolve
    })
    const turnId = testId('turn', 'settling-interrupt')
    const engine = createEngine(createAgent(async () => {
      markStarted()
      await turnGate

      return completedTurnResult()
    }))
    const running = engine.run(turnRequest('thread-settling-interrupt', turnId), store).completed

    await started
    const transaction = store.transaction.bind(store)
    let blockSettlement = true

    store.transaction = callback => transaction(async (tx) => {
      const result = await callback(tx)

      if (blockSettlement) {
        blockSettlement = false
        markSettlementStarted()
        await settlementGate
      }

      return result
    })
    const firstInterrupt = engine.interrupt({
      agentId: 'code',
      threadId: 'thread-settling-interrupt',
      turnId,
      store,
      reason: '用户中断',
    })

    releaseTurn()
    await settlementStarted

    const readByChild = vi.spyOn(store.spawnEdges, 'readByChild')
      .mockRejectedValue(new Error('不应回退到 Child 取消'))

    onTestFinished(() => readByChild.mockRestore())
    let lateSettled = false
    const lateInterrupt = engine.interrupt({
      agentId: 'code',
      threadId: 'thread-settling-interrupt',
      turnId,
      store,
      reason: '迟到的中断',
    }).then((result) => {
      lateSettled = true
      return result
    })

    await Promise.resolve()
    expect(lateSettled).toBe(false)

    releaseSettlement()
    await expect(running).rejects.toThrow('用户中断')
    await expect(firstInterrupt).resolves.toBe(true)
    await expect(lateInterrupt).resolves.toBe(false)
    expect(readByChild).not.toHaveBeenCalled()
  }
  finally {
    releaseTurn()
    releaseSettlement()
    await disposeEngineStore(root, store)
  }
})

posixTest('AgentEngine interrupt preserves the Thread shell until Runtime disposal', async () => {
  const { root, store } = await createEngineStore()
  const workspace = path.join(root, 'workspace')
  const sandbox = createTestSandbox(workspace)
  const threadId = 'thread-shell-interrupt'
  let sessionId: string | undefined
  const events: RuntimeEvent[] = []
  const agent = createAgent(async (options) => {
    const result = await options.services.runtime.sandbox().shell.run(
      'echo $$ > shell.pid; sleep 30 & echo $! > child.pid',
      {
        shell: 'sh',
        signal: options.signal,
      },
    )

    sessionId = result.sessionId
    return completedTurnResult()
  })
  const runtime = {
    ...createTestRuntime({ workspaceId: 'default', workspaceKind: 'managed', workspaceRoot: workspace, dir: '.', cwd: workspace }),
    sandbox: () => sandbox,
    dispose: () => sandbox.shell.dispose(),
  }

  agent.runtime.create = () => runtime
  const engine = createEngine(agent)

  try {
    const pidFile = path.join(workspace, 'shell.pid')
    const childPidFile = path.join(workspace, 'child.pid')
    const running = engine.run({
      ...turnRequest(threadId, testId('turn', 'shell-interrupt')),
      location: {
        workspaceId: 'default',
        workspaceKind: 'managed',
        workspaceRoot: workspace,
        dir: '.',
        cwd: workspace,
      },
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    }, store).completed

    // 中断 Turn 只结束工具调用
    await waitForProcessExit(pidFile)
    const interrupted = engine.interrupt({
      agentId: 'code',
      threadId,
      store,
      reason: '用户中断',
    })

    await expect(running).rejects.toThrow('用户中断')
    await expect(interrupted).resolves.toBe(true)
    const turn = await store.turns.read(testId('turn', 'shell-interrupt'))
    const terminal = events.find(event => event.type === 'turn.interrupted')

    expect(turn).toMatchObject({
      status: 'interrupted',
      interrupt: {
        kind: 'system',
        status: 'pending',
        turnId: testId('turn', 'shell-interrupt'),
        reason: expect.any(String),
        resumableWith: ['message'],
      },
    })
    expect(await store.threads.read(threadId)).toMatchObject({
      status: 'interrupted',
      unreadAt: null,
      state: { extensionState: {} },
    })
    expect(terminal).toMatchObject({
      interruptId: turn?.interrupt?.id,
      payload: turn?.interrupt,
    })
    expect(sessionId).toMatch(/^process_/)
    await expect(sandbox.shell.write(sessionId!, { yield: 0.1 })).resolves.toMatchObject({
      status: 'running',
      sessionId,
    })
    const childPid = Number.parseInt((await readFile(childPidFile, 'utf8')).trim(), 10)

    expect(() => process.kill(childPid, 0)).not.toThrow()
    await engine.disposeRuntimes([threadId])
    await waitForProcessExit(childPidFile)
  }
  finally {
    await engine.disposeRuntimes([threadId])
    await sandbox.shell.dispose()
    await disposeEngineStore(root, store)
  }
}, 5_000)

test('a late Agent completion cannot overwrite a cancelled Turn terminal state', async () => {
  const { root, store } = await createEngineStore()

  try {
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const engine = createEngine(createAgent(async () => {
      markStarted()
      await gate
      return completedTurnResult()
    }))
    const running = engine.run(turnRequest('thread-cancelled', testId('turn', 'cancelled')), store).completed

    await started
    await store.turns.transition(testId('turn', 'cancelled'), ['running'], {
      status: 'cancelled',
      endedAt: dayjs().toISOString(),
    })
    release()
    await running

    expect(await store.turns.read(testId('turn', 'cancelled'))).toMatchObject({
      status: 'cancelled',
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})

test('an aborted Turn cannot complete when the Agent returns without observing its signal', async () => {
  const { root, store } = await createEngineStore()

  try {
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const engine = createEngine(createAgent(async () => {
      markStarted()
      await gate

      return completedTurnResult()
    }))
    const running = engine.run(turnRequest('thread-aborted-return', testId('turn', 'aborted-return')), store).completed

    await started
    const interrupted = engine.interrupt({
      agentId: 'code',
      threadId: 'thread-aborted-return',
      store,
      reason: '用户停止运行',
    })
    release()

    await expect(running).rejects.toThrow('用户停止运行')
    await interrupted
    expect(await store.turns.read(testId('turn', 'aborted-return'))).toMatchObject({
      status: 'interrupted',
      errorMessage: '用户停止运行',
    })
  }
  finally {
    await disposeEngineStore(root, store)
  }
})
