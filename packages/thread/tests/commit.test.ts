import { createId } from '@elmino/shared'
import {
  canonicalRecordToMessage,
  commitToolState,
  hydrateThreadMessages,
  settleTurnOutputTx,
  ThreadCommitter,
} from '@elmino/thread'
import { expect, test } from 'vitest'
import { createThreadStore } from './support/store'

test('完整 sampling 保留 Provider 事实与工具关联，显示输出不污染恢复后的模型结果', async () => {
  const { store, threadId, turnId } = await createThreadStore()
  const committer = ThreadCommitter.create(store, { threadId, turnId })
  const messageId = createId('msg')
  const identity = { messageId, textPartId: createId('part'), reasoningPartId: createId('part') }

  await committer.commitStep({
    ...identity,
    message: {
      role: 'assistant',
      id: 'provider-response',
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
      metadata: { provider: 'test' },
      parts: [
        { type: 'reasoning', text: 'reason', signature: 'signed-reasoning', visibility: 'context-only' },
        { type: 'tool-call', id: 'call-a', name: 'lookup', args: { query: 'sample' } },
      ],
    },
    text: '',
    reasoning: '',
    snapshot: {},
    hiddenTools: {},
    projectToolPart: () => Promise.resolve({ handled: false }),
  })
  const ownership = (await store.toolCalls.list({ turnId }))[0]!
  const events: string[] = []

  await commitToolState({
    store,
    ownership,
    status: 'completed',
    decision: 'auto',
    output: 'user-visible result',
    result: { type: 'tool-result', callId: 'call-a', result: [{ type: 'text', text: 'provider-visible result' }] },
    emitRuntime: async (type) => {
      expect((await store.toolCalls.list({ turnId }))[0]?.status).toBe('completed')
      events.push(type)
    },
  })
  const canonical = await store.canonical.list(threadId)
  const first = await store.canonical.readMessage(threadId, canonical[0]!.id)
  const last = await store.canonical.readMessage(threadId, canonical[1]!.id)

  expect(canonicalRecordToMessage(first!)).toMatchObject({ id: 'provider-response', rawFinishReason: 'tool_use', metadata: { provider: 'test' } })
  expect(canonicalRecordToMessage(first!).parts[0]).toMatchObject({ signature: 'signed-reasoning', visibility: 'context-only' })
  expect(canonicalRecordToMessage(last!).parts[0]).toEqual({ type: 'tool-result', callId: 'call-a', name: 'lookup', result: [{ type: 'text', text: 'provider-visible result' }] })
  const hydrated = await hydrateThreadMessages({ store, threadId })

  expect(hydrated[0]?.parts.find(part => part.type === 'tool')).toMatchObject({
    toolCallId: ownership.id,
    providerCallId: 'call-a',
    status: 'completed',
    output: 'user-visible result',
  })
  expect((await store.transcript.read(messageId))?.parts.find(part => part.type === 'tool')).not.toHaveProperty('output')
  expect(events).toEqual(['message.part.updated'])
})

test('失败采样的工具调用立即补齐配对失败结果，重复 Turn 结算不追加第二份工具结果', async () => {
  const { store, threadId, turnId } = await createThreadStore()
  const committer = ThreadCommitter.create(store, { threadId, turnId })

  await committer.commitStep({
    messageId: createId('msg'),
    textPartId: createId('part'),
    reasoningPartId: createId('part'),
    message: { role: 'assistant', parts: [{ type: 'tool-call', id: 'call-failed', name: 'lookup', args: {} }] },
    toolFailure: 'sampling interrupted',
    text: '',
    reasoning: '',
    snapshot: {},
    hiddenTools: {},
    projectToolPart: () => Promise.reject(new Error('failed sampling cannot execute tool projection')),
  })
  const before = await store.canonical.list(threadId)

  await store.transaction(tx => settleTurnOutputTx(tx, threadId, turnId, 'failed', 'failed', new Date().toISOString()))
  await store.transaction(tx => settleTurnOutputTx(tx, threadId, turnId, 'failed', 'failed', new Date().toISOString()))
  expect(await store.canonical.list(threadId)).toHaveLength(before.length)
  expect((await store.toolCalls.list({ turnId }))[0]).toMatchObject({ status: 'failed', errorMessage: 'sampling interrupted' })
  const result = await store.canonical.readMessage(threadId, before[1]!.id)

  expect(canonicalRecordToMessage(result!).parts[0]).toMatchObject({ type: 'tool-result', callId: 'call-failed', result: 'sampling interrupted', error: true })
})

test('未完成采样只提交安全 partial 与 transcript，压缩边界允许宿主文案且不进入 Canonical', async () => {
  const { store, threadId, turnId } = await createThreadStore()
  const committer = ThreadCommitter.create(store, { threadId, turnId })
  const ref = { messageId: createId('msg'), textPartId: createId('part'), reasoningPartId: createId('part') }

  await committer.checkpoint({ ...ref, text: 'partial', reasoning: 'reason' })
  await committer.commitPartial({ ...ref, text: 'safe text', reasoning: 'safe reason', status: 'interrupted', snapshot: {} })
  expect(await store.canonical.list(threadId)).toEqual([])
  expect((await store.transcript.read(ref.messageId))?.status).toBe('interrupted')
  const event = await committer.commitCompaction({ title: 'Customized compaction label' })

  expect(event.parts[0]).toMatchObject({ type: 'event', title: 'Customized compaction label' })
  expect(await store.canonical.list(threadId)).toEqual([])
})

test('中断未结算工具批次时，每个调用都有配对失败结果并关闭尚在流式输出的消息', async () => {
  const { store, threadId, turnId } = await createThreadStore()
  const committer = ThreadCommitter.create(store, { threadId, turnId })
  const messageId = createId('msg')

  await committer.commitStep({
    messageId,
    textPartId: createId('part'),
    reasoningPartId: createId('part'),
    message: {
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'call-one', name: 'lookup', args: { order: 1 } },
        { type: 'tool-call', id: 'call-two', name: 'lookup', args: { order: 2 } },
      ],
    },
    text: '',
    reasoning: '',
    snapshot: {},
    hiddenTools: {},
    projectToolPart: () => Promise.resolve({ handled: false }),
  })
  const openMessageId = createId('msg')

  await committer.checkpoint({
    messageId: openMessageId,
    textPartId: createId('part'),
    reasoningPartId: createId('part'),
    text: 'unfinished',
    reasoning: '',
  })
  const settledAt = new Date().toISOString()

  await store.transaction(tx => settleTurnOutputTx(tx, threadId, turnId, 'interrupted', 'stopped', settledAt))
  const tools = await store.toolCalls.list({ turnId })

  expect(tools.map(tool => tool.status)).toEqual(['failed', 'failed'])
  expect(tools.every(tool => tool.resultPartId !== null)).toBe(true)
  const canonical = await store.canonical.list(threadId)
  const results = await Promise.all(canonical.slice(1).map(record => store.canonical.readMessage(threadId, record.id)))

  const parts = results.map(record => canonicalRecordToMessage(record!).parts[0])

  expect(parts).toHaveLength(2)
  expect(parts).toEqual(expect.arrayContaining([
    { type: 'tool-result', callId: 'call-one', name: 'lookup', result: 'stopped', error: true },
    { type: 'tool-result', callId: 'call-two', name: 'lookup', result: 'stopped', error: true },
  ]))
  expect((await store.transcript.read(openMessageId))?.status).toBe('interrupted')
  expect((await hydrateThreadMessages({ store, threadId })).find(message => message.id === messageId)?.parts.filter(part => part.type === 'tool').map(part => part.status)).toEqual(['failed', 'failed'])
})
