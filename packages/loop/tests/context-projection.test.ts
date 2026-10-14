import type { ModelTurnConfig, Request, TurnModel } from '@elmino/llm'
import type { RuntimeStore, ThreadMessage } from '@elmino/store'
import type { ContextProjectionState } from '@elmino/thread'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createContextBudget } from '../src/budget/index'
import { ContextProjection } from '../src/context-projection/index'
import { testFiles } from './support/files'
import { testSubagentRole, testSubagentRoles } from './support/subagent'

/** -------------------- 测试状态 -------------------- */
let root = ''
let store: Awaited<ReturnType<typeof SqliteStore.create>>

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'elmino-context-projection-'))
  const blobStore = LocalBlobStore.create({
    files: testFiles,
    rootDir: path.join(root, 'blobs'),
  })

  store = await SqliteStore.create({
    dataDir: path.join(root, 'db'),
    blobStore,
  })
  await store.threads.upsert({ id: 'thread_projection', dir: '.', agentId: 'code' })
})

afterEach(async () => {
  await store.close()
  await rm(root, { force: true, recursive: true })
})

/** -------------------- 测试 -------------------- */
test('缩半重试后仍超过压力线时继续压缩剩余历史', async () => {
  for (let index = 0; index < 6; index++)
    await appendTextTurn(`turn_retry_pressure_${index}`, 'x'.repeat(24_000))
  const model = createModel(20_000, ['摘要'], 'completed', [new Error('prompt_too_long')])
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()

  expect(model.requests).toHaveLength(3)
  expect(result.usedTokens).toBeLessThan(15_000)
  expect(await store.canonical.list('thread_projection')).toHaveLength(6)
})

test('系统上下文本身超限时停止请求且保留原始历史', async () => {
  await appendTextTurn('turn_fixed_context', '用户输入')
  const model = createModel(10_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  await expect(projection.beforeModelCall({
    system: [{ type: 'text', text: 'x'.repeat(44_000) }],
  }))
    .rejects
    .toThrow('压缩后上下文仍超出模型容量')
  expect(await store.canonical.list('thread_projection')).toHaveLength(1)
})

test('旧摘要、重复动态消息和超限预算在数据库重开后继续压缩，原始历史保持完整', async () => {
  await appendTextTurn('turn_old_summary', '已由旧摘要覆盖的原始记录')
  for (let index = 0; index < 3; index++) {
    await appendTextTurn(`turn_old_dynamic_${index}`, [
      '<runtime_context_update tag="skills_instructions">',
      '旧技能目录'.repeat(3_500),
      '</runtime_context_update>',
    ].join('\n'))
  }
  const initialState = {
    summary: { text: '旧摘要中的用户约束', throughSeq: 1, throughMessageId: canonicalMessageId(1) },
  }
  const extensionState = { todo: { todos: [{ content: '继续旧任务', status: 'in_progress' }] } }
  await store.threads.upsert({
    id: 'thread_projection',
    state: {
      contextProjection: initialState,
      extensionState,
      contextBudget: createContextBudget(51_500, 4, 50_000, 'approximate'),
    },
  })
  const originalMessages = await store.canonical.list('thread_projection')
  const partIds = (await store.canonical.listParts('thread_projection')).map(part => part.id)
  const originalParts = await store.canonical.readParts('thread_projection', partIds)
  const options = {
    dataDir: path.join(root, 'db'),
    blobStore: LocalBlobStore.create({
      files: testFiles,
      rootDir: path.join(root, 'blobs'),
    }),
  }
  await store.close()
  store = await SqliteStore.create(options)
  const saved = (await store.threads.read('thread_projection'))!
  const model = createModel(50_000, ['新摘要保留旧约束与任务进度'])
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: saved.state.contextProjection as ContextProjectionState,
  })
  expect(saved.state.contextProjection).toEqual(initialState)
  expect(saved.state.contextBudget).toMatchObject({ usedTokens: 51_500, remainingTokens: 0 })
  expect(JSON.stringify(await projection.project())).toContain('runtime_context_update')
  const result = await projection.beforeModelCall()
  expect(JSON.stringify(model.requests[0])).toContain('旧摘要中的用户约束')
  expect(JSON.stringify(model.requests[0])).toContain('runtime_context_update')
  expect(result.usedTokens).toBeLessThan(37_500)
  await store.threads.upsert({
    id: 'thread_projection',
    state: {
      ...saved.state,
      contextProjection: projection.readState(),
      contextBudget: createContextBudget(result.usedTokens, result.contextMessages.length, 50_000, result.estimation),
    },
  })
  await store.close()
  store = await SqliteStore.create(options)
  const reopened = (await store.threads.read('thread_projection'))!
  const restored = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: reopened.state.contextProjection as ContextProjectionState,
  })
  expect(await restored.project()).toEqual(result.contextMessages)
  expect(reopened.state.extensionState).toEqual(extensionState)
  expect(await store.canonical.list('thread_projection')).toEqual(originalMessages)
  expect(await store.canonical.readParts('thread_projection', partIds)).toEqual(originalParts)
})

test('low-pressure projection preserves complete provider messages without calling LLM', async () => {
  await appendTextTurn('turn_low_pressure', '原始用户输入')
  await store.canonical.append({
    id: canonicalMessageId(90),
    threadId: 'thread_projection',
    turnId: 'turn_low_pressure',
    role: 'assistant',
    providerId: 'provider_response_id',
    finishReason: 'completed',
    rawFinishReason: 'end_turn',
    metadata: { providerPrivate: true },
    parts: [{
      id: canonicalPartId(90),
      type: 'reasoning',
      content: {
        type: 'reasoning',
        text: '分析',
        signature: 'signature',
        metadata: { itemId: 'reasoning_1' },
      },
    }, {
      id: canonicalPartId(91),
      type: 'text',
      content: { type: 'text', text: '完整回答' },
    }],
  })
  const model = createModel(100_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()

  expect(result.contextMessages.at(-1)).toEqual({
    role: 'assistant',
    id: 'provider_response_id',
    finishReason: 'completed',
    rawFinishReason: 'end_turn',
    metadata: { providerPrivate: true },
    parts: [{
      type: 'reasoning',
      text: '分析',
      signature: 'signature',
      metadata: { itemId: 'reasoning_1' },
    }, {
      type: 'text',
      text: '完整回答',
    }],
  })
  expect(projection.readState()).toEqual({})
  expect(model.requests).toEqual([])
})

test('模型上下文只恢复工具确认，展示清单保留在原始记录中', async () => {
  const turnId = 'turn_diff_result'
  const output = JSON.stringify({ files: [{ path: 'report.md', description: '展示专用说明' }] })
  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(92),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(92),
      type: 'tool-call',
      content: { type: 'tool-call', id: 'call_diff', name: 'diff', args: {} },
    }],
  }, {
    id: canonicalMessageId(93),
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: canonicalPartId(93),
      type: 'tool-result',
      content: { type: 'tool-result', callId: 'call_diff', name: 'diff', result: '文件变更已登记', output },
    }],
  }])
  const model = createModel(100_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  // 初次请求和重新恢复都仅使用模型结果，且不改写原始展示内容
  for (let index = 0; index < 2; index++) {
    const result = await projection.beforeModelCall()
    const parts = result.contextMessages.flatMap(message => message.parts)
    expect(parts).toContainEqual({ type: 'tool-result', callId: 'call_diff', name: 'diff', result: '文件变更已登记' })
    expect(JSON.stringify(result.contextMessages)).not.toContain('展示专用说明')
    expect(parts.some(part => part.type === 'tool-call' && part.id === 'call_diff')).toBe(true)
  }
  const [stored] = await store.canonical.readParts('thread_projection', [canonicalPartId(93)])
  expect(stored?.content.output).toBe(output)
})

test('上下文过滤先于 Token 统计及摘要请求，删除消息后保持原始摘要边界', async () => {
  const resultPartId = await appendToolTurn(1, '历史工具完整内容'.repeat(500))
  await appendTextTurn('turn_context_recent', '近期正文')
  const model = createModel(100_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    process: messages => messages.flatMap(item => (
      item.turnId === 'turn_tool_1' && item.message.role !== 'user' ? [] : [item]
    )),
  })
  const result = await projection.beforeModelCall()
  expect(result.usedTokens).toBeLessThan(200)
  expect(model.requests).toEqual([])
  const context = await projection.compactHistory()
  const request = JSON.stringify(model.requests[0]?.messages)
  expect(request).toContain('工具问题 1')
  expect(request).not.toContain('历史工具完整内容')
  expect(request).not.toContain('call_1')
  expect(projection.readState().summary?.throughMessageId).toBe(canonicalMessageId(13))
  expect(JSON.stringify(context)).toContain('近期正文')
  const original = await store.canonical.readPart('thread_projection', resultPartId)
  expect(original?.content.result).toBe('历史工具完整内容'.repeat(500))
})

test('整批重排后摘要仍按消息 ID 关联原始归属和边界', async () => {
  await appendTextTurn('turn_first', '第一条'.repeat(1_000))
  await appendTextTurn('turn_second', '第二条'.repeat(1_000))
  await appendTextTurn('turn_recent', '近期内容')
  const model = createModel(1_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    process: messages => [...messages].reverse(),
  })

  await projection.compactHistory()
  const part = model.requests[0]?.messages[0]?.parts[0]
  expect(part?.type).toBe('text')
  const prompt = part?.type === 'text' ? part.text : ''
  expect(prompt).toContain(`"id":"${canonicalMessageId(2)}","seq":2,"turnId":"turn_second"`)
  expect(prompt).toContain(`"id":"${canonicalMessageId(1)}","seq":1,"turnId":"turn_first"`)
  expect(prompt.indexOf(canonicalMessageId(2))).toBeLessThan(prompt.indexOf(canonicalMessageId(1)))
  expect(projection.readState().summary?.throughMessageId).toBe(canonicalMessageId(2))
  expect((await store.canonical.list('thread_projection')).map(record => record.turnId))
    .toEqual(['turn_first', 'turn_second', 'turn_recent'])
})

test('automatic pressure threshold stays at 75 percent for a 100K context', async () => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_pressure_ratio_${index}`, `${index}-${'p'.repeat(102_000)}`)
  const model = createModel(100_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  await projection.beforeModelCall()

  expect(projection.readState().summary?.throughSeq).toBeGreaterThan(0)
  expect(model.requests).toHaveLength(1)
})

test('projection restores parallel tool result order and skips empty assistant messages', async () => {
  const turnId = 'turn_parallel_projection'

  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(120),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(120),
      type: 'tool-call',
      content: { type: 'tool-call', id: 'call_first', name: 'shell', args: {} },
    }, {
      id: canonicalPartId(121),
      type: 'tool-call',
      content: { type: 'tool-call', id: 'call_second', name: 'shell', args: {} },
    }],
  }, {
    id: canonicalMessageId(122),
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: canonicalPartId(122),
      type: 'tool-result',
      content: { type: 'tool-result', callId: 'call_second', result: 'second' },
    }],
  }, {
    id: canonicalMessageId(125),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(125),
      type: 'text',
      content: { type: 'text', text: '恢复审批' },
    }],
  }, {
    id: canonicalMessageId(123),
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: canonicalPartId(123),
      type: 'tool-result',
      content: { type: 'tool-result', callId: 'call_first', result: 'first' },
    }],
  }, {
    id: canonicalMessageId(124),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    finishReason: 'completed',
    parts: [],
  }])
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: createModel(100_000).turnModel,
    state: {},
  })
  const messages = await projection.project()

  expect(messages).toHaveLength(3)
  expect(messages[1]).toEqual({
    role: 'tool',
    parts: [{
      type: 'tool-result',
      callId: 'call_first',
      result: 'first',
    }, {
      type: 'tool-result',
      callId: 'call_second',
      result: 'second',
    }],
  })
  expect(messages[2]).toEqual({
    role: 'user',
    parts: [{ type: 'text', text: '恢复审批' }],
  })
})

test('pressure projects every over-budget tool result as a readable placeholder without calling LLM', async () => {
  const oldResultPartId = await appendToolTurn(1, 'x'.repeat(120_000))
  const protectedResultPartId = await appendToolTurn(2, 'y'.repeat(120_000))

  await appendTextTurn('turn_recent_1', '最近问题 1')

  const model = createModel(60_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()
  const projected = JSON.stringify(result.contextMessages)

  expect(projection.readState()).toEqual({})
  expect(projected).toContain(oldResultPartId)
  expect(projected).toContain(protectedResultPartId)
  expect(projected).toContain('readContext')
  expect(projected).not.toContain('x'.repeat(1_000))
  expect(projected).not.toContain('y'.repeat(1_000))
  expect(model.requests).toEqual([])
})

test('projection never loads an over-budget tool result BLOB', async () => {
  const resultPartId = await appendToolTurn(2, 'SECRET_BLOB'.repeat(10_000))
  const loadedIds: string[][] = []
  const trackingStore: RuntimeStore = {
    threads: store.threads,
    transcript: store.transcript,
    canonical: {
      ...store.canonical,
      readParts: (threadId, ids) => {
        loadedIds.push(ids)
        return store.canonical.readParts(threadId, ids)
      },
    },
    turns: store.turns,
    steps: store.steps,
    toolCalls: store.toolCalls,
    spawnEdges: store.spawnEdges,
    turnSpawnEdges: store.turnSpawnEdges,
    artifacts: store.artifacts,
    transaction: store.transaction.bind(store),
    close: store.close.bind(store),
  }
  const model = createModel(20_000)
  const projection = ContextProjection.create({
    store: trackingStore,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const messages = await projection.project()

  expect(loadedIds.flat()).not.toContain(resultPartId)
  expect(JSON.stringify(messages)).not.toContain('SECRET_BLOB')
})

test('summary input uses the same tool result placeholders and stays within model budget', async () => {
  const resultPartId = await appendToolTurn(1, 'SECRET_BLOB'.repeat(12_000))

  for (let index = 1; index <= 4; index++)
    await appendTextTurn(`turn_summary_input_${index}`, `${index}-${'h'.repeat(16_000)}`)

  const model = createModel(20_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()
  const requestJson = JSON.stringify(model.requests[0])

  expect(model.requests).toHaveLength(1)
  expect(requestJson).toContain(resultPartId)
  expect(requestJson).toContain('readContext')
  expect(requestJson).not.toContain('SECRET_BLOB')
  expect(result.usedTokens).toBeLessThan(15_000)
})

test('summary slides by complete turns and next summary receives only the new head', async () => {
  for (let index = 1; index <= 4; index++)
    await appendTextTurn(`turn_summary_${index}`, `${index}-${'a'.repeat(24_000)}`)

  const model = createModel(20_000, ['第一版摘要', '第二版摘要'])
  const compacting: boolean[] = []
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    onCompacting: (value) => {
      compacting.push(value)
    },
  })
  const first = await projection.beforeModelCall()
  const firstState = projection.readState().summary

  expect(firstState?.text).toBe('第一版摘要')
  expect(firstState?.throughMessageId).toBe(canonicalMessageId(3))
  expect(first.contextMessages[0]?.parts[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining(firstState!.throughMessageId),
  })
  expect(first.contextMessages[0]?.parts[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('history'),
  })

  await appendTextTurn('turn_summary_5', `5-${'b'.repeat(24_000)}`)
  await projection.compactHistory()
  const secondState = projection.readState().summary
  const secondPrompt = model.requests[1]?.messages[0]?.parts[0]
  const secondText = secondPrompt?.type === 'text' ? secondPrompt.text : ''

  expect(secondState?.text).toBe('第二版摘要')
  expect(secondState?.throughSeq).toBeGreaterThan(firstState?.throughSeq ?? 0)
  expect(secondText).toContain('第一版摘要')
  expect(secondText).not.toContain(canonicalMessageId(1))
  expect(secondText).toContain(canonicalMessageId(4))
  expect(secondText).toContain(canonicalPartId(4))
  expect(compacting).toEqual([true, false, true, false])
})

test('one Runtime Turn slides completed sampling units on the first pressure trigger', async () => {
  const conversation = await appendSamplingConversation('turn_single_runtime')
  const model = createModel(20_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()
  const summary = projection.readState().summary

  expect(model.requests).toHaveLength(1)
  expect(summary?.throughSeq).toBeGreaterThan(0)
  expect(summary?.throughMessageId).toBe(conversation.secondResultMessageId)
  expect(JSON.stringify(result.contextMessages)).not.toContain('a'.repeat(1_000))
  expect(JSON.stringify(result.contextMessages)).toContain('c'.repeat(1_000))
})

test('a new Turn with only a user message keeps that message and slides the previous Turn', async () => {
  const previousTurnId = 'turn_previous_complete'
  const currentTurnId = 'turn_current_user_only'

  await createTurn(previousTurnId)
  await createTurn(currentTurnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(680),
    threadId: 'thread_projection',
    turnId: previousTurnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(680),
      type: 'text',
      content: { type: 'text', text: `previous-user-${'p'.repeat(24_000)}` },
    }],
  }, {
    id: canonicalMessageId(681),
    threadId: 'thread_projection',
    turnId: previousTurnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(681),
      type: 'text',
      content: { type: 'text', text: `previous-assistant-${'a'.repeat(24_000)}` },
    }],
  }, {
    id: canonicalMessageId(682),
    threadId: 'thread_projection',
    turnId: currentTurnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(682),
      type: 'text',
      content: { type: 'text', text: `current-user-${'c'.repeat(16_000)}` },
    }],
  }])
  const model = createModel(20_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()

  expect(projection.readState().summary?.throughMessageId).toBe(
    canonicalMessageId(681),
  )
  expect(JSON.stringify(result.contextMessages)).toContain('current-user-')
  expect(JSON.stringify(result.contextMessages)).not.toContain('previous-user-')
})

test('an unsettled tool protects its sampling unit while older settled units still slide', async () => {
  const conversation = await appendSamplingConversation(
    'turn_unsettled_sampling',
    2,
  )
  const model = createModel(20_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  await projection.compactHistory()
  const summary = projection.readState().summary
  const prompt = JSON.stringify(model.requests[0])

  expect(summary?.throughMessageId).toBe(conversation.firstResultMessageId)
  expect(prompt).toContain(conversation.firstAssistantMessageId)
  expect(prompt).not.toContain(conversation.secondAssistantMessageId)
})

test('one settled over-pressure unit can slide completely and leave an empty tail', async () => {
  const turnId = 'turn_single_settled_unit'

  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(700),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(700),
      type: 'text',
      content: { type: 'text', text: 'u'.repeat(16_000) },
    }],
  }, {
    id: canonicalMessageId(701),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(701),
      type: 'text',
      content: { type: 'text', text: 'a'.repeat(16_000) },
    }],
  }])
  const model = createModel(10_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })
  const result = await projection.beforeModelCall()

  expect(projection.readState().summary?.throughMessageId).toBe(
    canonicalMessageId(701),
  )
  expect(result.contextMessages).toHaveLength(1)
  expect(JSON.stringify(result.contextMessages[0])).toContain('测试摘要')
  expect(model.requests[0]?.maxOutputTokens).toBe(1_500)
  expect(model.requests[0]?.reasoning).toBeUndefined()
})

test('one unsettled over-pressure unit never advances the summary boundary', async () => {
  const turnId = 'turn_single_unsettled_unit'
  const assistantPartId = canonicalPartId(711)

  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(710),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(710),
      type: 'text',
      content: { type: 'text', text: 'u'.repeat(32_000) },
    }],
  }, {
    id: canonicalMessageId(711),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: assistantPartId,
      type: 'tool-call',
      content: { type: 'tool-call', id: 'call_open', name: 'shell', args: {} },
    }],
  }])
  await appendRuntimeToolCall(turnId, assistantPartId, 'call_open')
  const model = createModel(10_000)
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  await projection.beforeModelCall()

  expect(projection.readState()).toEqual({})
  expect(model.requests).toEqual([])
})

test('blank text summary failure leaves state and pending events unchanged', async () => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_blank_${index}`, `${index}-${'z'.repeat(30_000)}`)
  let eventCount = 0
  const model = createModel(20_000, ['   '])
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    onCompact: () => {
      eventCount++
    },
  })

  await expect(projection.beforeModelCall()).rejects.toThrow('上下文摘要为空')
  await projection.flushEvents()

  expect(projection.readState()).toEqual({})
  expect(eventCount).toBe(0)
})

test('truncated text summary leaves state and pending events unchanged', async () => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_truncated_${index}`, `${index}-${'z'.repeat(30_000)}`)
  let eventCount = 0
  const model = createModel(20_000, ['未完成摘要'], 'truncated')
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    onCompact: () => {
      eventCount++
    },
  })

  await expect(projection.beforeModelCall()).rejects.toThrow('上下文摘要输出被截断')
  await projection.flushEvents()

  expect(projection.readState()).toEqual({})
  expect(eventCount).toBe(0)
  expect(model.requests).toHaveLength(2)
})

test('truncated summary retries once with half of the safe prefix', async () => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_retry_${index}`, `${index}-${'r'.repeat(30_000)}`)
  const compacting: boolean[] = []
  const model = createModel(
    20_000,
    ['未完成摘要', '重试摘要'],
    ['truncated', 'completed'],
  )
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    onCompacting: (value) => {
      compacting.push(value)
    },
  })

  await projection.beforeModelCall()

  expect(model.requests).toHaveLength(3)
  expect(model.requests.map(request => request.maxOutputTokens)).toEqual([
    3_000,
    5_000,
    3_000,
  ])
  expect(JSON.stringify(model.requests[0])).toContain(canonicalMessageId(2))
  expect(JSON.stringify(model.requests[1])).not.toContain(canonicalMessageId(2))
  expect(projection.readState().summary).toMatchObject({
    text: '重试摘要',
    throughMessageId: canonicalMessageId(2),
  })
  expect(compacting).toEqual([true, false, true, false])
})

test('prompt overflow retries once with half of the safe prefix', async () => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_overflow_${index}`, `${index}-${'o'.repeat(30_000)}`)
  const model = createModel(
    20_000,
    ['未使用', '溢出重试摘要'],
    'completed',
    [new Error('prompt_too_long')],
  )
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
  })

  await projection.beforeModelCall()

  expect(model.requests).toHaveLength(3)
  expect(model.requests.map(request => request.maxOutputTokens)).toEqual([
    3_000,
    5_000,
    3_000,
  ])
  expect(JSON.stringify(model.requests[0])).toContain(canonicalMessageId(2))
  expect(JSON.stringify(model.requests[1])).not.toContain(canonicalMessageId(2))
  expect(projection.readState().summary).toMatchObject({
    text: '溢出重试摘要',
    throughMessageId: canonicalMessageId(2),
  })
})

test('pending compaction events publish serially and continue after one failure', async () => {
  for (let index = 1; index <= 4; index++)
    await appendTextTurn(`turn_events_${index}`, `${index}-${'e'.repeat(24_000)}`)
  const published: number[] = []
  let active = 0
  let maxActive = 0
  const model = createModel(20_000, ['第一版', '第二版'])
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: {},
    onCompact: async () => {
      const attempt = published.length + 1
      active++
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active--
      published.push(attempt)

      if (published.length === 1)
        throw new Error('first marker failed')
    },
  })

  await projection.beforeModelCall()
  await appendTextTurn('turn_events_5', `5-${'f'.repeat(24_000)}`)
  await projection.compactHistory()
  await projection.flushEvents()

  expect(published).toEqual([1, 2])
  expect(maxActive).toBe(1)
})

test.each(['failed', 'aborted'] as const)('摘要请求 %s 时保留旧摘要并允许重试', async (status) => {
  for (let index = 1; index <= 3; index++)
    await appendTextTurn(`turn_failure_${index}`, `${index}-${'z'.repeat(30_000)}`)

  const error = status === 'aborted'
    ? new DOMException('summary aborted', 'AbortError')
    : new Error('summary failed')
  const model = createModel(20_000, ['重试成功摘要'], 'completed', [error])
  const initialState = {
    summary: { text: '已保存的旧摘要', throughSeq: 1, throughMessageId: canonicalMessageId(1) },
  }
  const compacting: boolean[] = []
  const projection = ContextProjection.create({
    store,
    threadId: 'thread_projection',
    model: model.turnModel,
    state: initialState,
    onCompacting: (value) => {
      compacting.push(value)
    },
  })
  await expect(projection.beforeModelCall()).rejects.toBe(error)
  const contextMessages = await projection.project()

  expect(projection.readState()).toEqual(initialState)
  expect(contextMessages[0]?.parts[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('已保存的旧摘要'),
  })
  expect(model.requests).toHaveLength(1)
  expect(compacting).toEqual([true, false])
  await projection.beforeModelCall()
  expect(projection.readState().summary?.text).toBe('重试成功摘要')
  expect(await store.canonical.list('thread_projection')).toHaveLength(3)
})

/** -------------------- 内部函数 -------------------- */
/**
 * 创建可记录摘要请求的测试 TurnModel
 */
function createModel(
  context: number,
  summaries = ['测试摘要'],
  finishReason: 'completed' | 'truncated' | Array<'completed' | 'truncated'> = 'completed',
  errors: Array<Error | undefined> = [],
) {
  const requests: Request[] = []
  const turnModel: TurnModel<ModelTurnConfig> = {
    config: {
      id: 'model_11111111-1111-4111-8111-111111111111',
      providerId: 'provider_11111111-1111-4111-8111-111111111111',
      providerName: 'test',
      name: 'test-model',
      label: 'Test Model',
      apiFormat: 'anthropic-messages',
      baseURL: 'https://example.com',
      cache: { mode: 'disabled' },
      limit: { context },
      jsonSchema: true,
      inputModalities: [],
    },
    adapter: {
      name: 'test',
      model: 'test-model',
      capabilities: {
        cache: { modes: ['disabled'] },
        reasoning: true,
        tools: true,
        jsonSchema: true,
      },
      generate: request => turnModel.adapter.stream(request),
      generateObject: () => Promise.reject(new Error('上下文投影不应请求结构化对象')),
      stream: (request: Request) => {
        requests.push(request)

        const error = errors[requests.length - 1]

        if (error)
          throw error

        const summary = summaries[requests.length - 1] ?? summaries.at(-1)!
        const reason = Array.isArray(finishReason)
          ? finishReason[requests.length - 1] ?? finishReason.at(-1)!
          : finishReason

        return Promise.resolve({
          message: {
            role: 'assistant' as const,
            parts: [{
              type: 'text' as const,
              text: summary,
            }],
            finishReason: reason,
          },
          usage: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        })
      },
    },
  }

  return {
    requests,
    turnModel,
  }
}

/**
 * 追加一个只含用户文本的完整 Runtime Turn
 */
async function appendTextTurn(turnId: string, text: string) {
  const index = (await store.canonical.list('thread_projection')).length + 1

  await createTurn(turnId)
  await store.canonical.append({
    id: canonicalMessageId(index),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(index),
      type: 'text',
      content: { type: 'text', text },
    }],
  })
}

/**
 * 追加带工具调用和 ToolResult 指针的完整 Runtime Turn
 */
async function appendToolTurn(index: number, output: string) {
  const turnId = `turn_tool_${index}`
  const assistantPartId = canonicalPartId(index * 10 + 2)
  const resultPartId = canonicalPartId(index * 10 + 3)

  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(index * 10 + 1),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(index * 10 + 1),
      type: 'text',
      content: { type: 'text', text: `工具问题 ${index}` },
    }],
  }, {
    id: canonicalMessageId(index * 10 + 2),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    finishReason: 'tool-calls',
    parts: [{
      id: canonicalPartId(index * 10 + 2),
      type: 'tool-call',
      content: { type: 'tool-call', id: `call_${index}`, name: 'shell', args: { command: 'large' } },
    }],
  }, {
    id: canonicalMessageId(index * 10 + 3),
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: resultPartId,
      type: 'tool-result',
      content: { type: 'tool-result', callId: `call_${index}`, name: 'shell', result: output },
    }],
  }])
  const toolCallId = await appendRuntimeToolCall(
    turnId,
    assistantPartId,
    `call_${index}`,
    { command: 'large' },
  )

  await store.toolCalls.update(toolCallId, { resultPartId })

  return resultPartId
}

/**
 * 追加同一 Runtime Turn 内三次已闭合 Provider sampling
 */
async function appendSamplingConversation(turnId: string, openCall?: 1 | 2) {
  const base = turnId === 'turn_single_runtime' ? 500 : 600
  const firstAssistantMessageId = canonicalMessageId(base + 1)
  const firstAssistantPartId = canonicalPartId(base + 2)
  const firstResultMessageId = canonicalMessageId(base + 2)
  const firstResultPartId = canonicalPartId(base + 3)
  const secondAssistantMessageId = canonicalMessageId(base + 3)
  const secondAssistantPartId = canonicalPartId(base + 5)
  const secondResultMessageId = canonicalMessageId(base + 4)
  const secondResultPartId = canonicalPartId(base + 6)

  await createTurn(turnId)
  await store.canonical.appendMany([{
    id: canonicalMessageId(base),
    threadId: 'thread_projection',
    turnId,
    role: 'user',
    parts: [{
      id: canonicalPartId(base),
      type: 'text',
      content: { type: 'text', text: 'u'.repeat(16_000) },
    }],
  }, {
    id: firstAssistantMessageId,
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(base + 1),
      type: 'text',
      content: { type: 'text', text: 'a'.repeat(16_000) },
    }, {
      id: firstAssistantPartId,
      type: 'tool-call',
      content: { type: 'tool-call', id: `call_${base}_1`, name: 'shell', args: {} },
    }],
  }, {
    id: firstResultMessageId,
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: firstResultPartId,
      type: 'tool-result',
      content: { type: 'tool-result', callId: `call_${base}_1`, result: 'first' },
    }],
  }, {
    id: secondAssistantMessageId,
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(base + 4),
      type: 'text',
      content: { type: 'text', text: 'b'.repeat(16_000) },
    }, {
      id: secondAssistantPartId,
      type: 'tool-call',
      content: { type: 'tool-call', id: `call_${base}_2`, name: 'shell', args: {} },
    }],
  }, {
    id: secondResultMessageId,
    threadId: 'thread_projection',
    turnId,
    role: 'tool',
    parts: [{
      id: secondResultPartId,
      type: 'tool-result',
      content: { type: 'tool-result', callId: `call_${base}_2`, result: 'second' },
    }],
  }, {
    id: canonicalMessageId(base + 5),
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    parts: [{
      id: canonicalPartId(base + 7),
      type: 'text',
      content: { type: 'text', text: 'c'.repeat(16_000) },
    }],
  }])
  const firstToolCallId = await appendRuntimeToolCall(
    turnId,
    firstAssistantPartId,
    `call_${base}_1`,
  )
  const secondToolCallId = await appendRuntimeToolCall(
    turnId,
    secondAssistantPartId,
    `call_${base}_2`,
  )

  if (openCall !== 1)
    await store.toolCalls.update(firstToolCallId, { resultPartId: firstResultPartId })
  if (openCall !== 2)
    await store.toolCalls.update(secondToolCallId, { resultPartId: secondResultPartId })

  return {
    firstAssistantMessageId,
    firstResultMessageId,
    secondAssistantMessageId,
    secondResultMessageId,
  }
}

/**
 * 建立 Canonical tool-call Part 对应的运行期 ToolCall ownership
 */
async function appendRuntimeToolCall(
  turnId: string,
  assistantPartId: string,
  providerCallId: string,
  args: Record<string, unknown> = {},
) {
  const assistantMessageId = createId('msg')
  const createdAt = new Date().toISOString()
  const transcript: ThreadMessage = {
    id: assistantMessageId,
    threadId: 'thread_projection',
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'completed',
    parts: [{
      id: assistantPartId,
      messageId: assistantMessageId,
      threadId: 'thread_projection',
      turnId,
      seq: 1,
      type: 'tool',
      status: 'completed',
      providerCallId,
      toolName: 'shell',
      args,
      createdAt,
      updatedAt: createdAt,
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  }

  await store.transcript.upsert(transcript)
  const toolCall = await store.toolCalls.create({
    turnId,
    assistantMessageId,
    assistantPartId,
    providerCallId,
    name: 'shell',
    args,
    status: 'completed',
  })

  return toolCall.id
}

/**
 * 创建满足 Canonical 外键约束的 Turn
 */
function createTurn(turnId: string) {
  return store.turns.create({
    id: turnId,
    threadId: 'thread_projection',
    status: 'running',
    modelConfig: { id: 'model_test' },
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'request',
    subagentMode: 'explicitOnly',
  })
}

/**
 * 生成测试 Canonical Message ID
 */
function canonicalMessageId(index: number) {
  return `canonical_message_${index.toString().padStart(8, '0')}-0000-4000-8000-${index.toString().padStart(12, '0')}`
}

/**
 * 生成测试 Canonical Part ID
 */
function canonicalPartId(index: number) {
  return `canonical_part_${index.toString().padStart(8, '0')}-0000-4000-8000-${index.toString().padStart(12, '0')}`
}
