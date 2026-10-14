import { createId } from '@elmino/shared'
import { defineThread, readThreadSnapshot, updateThreadExtensionState, updateThreadSnapshot } from '@elmino/thread'
import { expect, test } from 'vitest'
import { createThreadStore } from './support/store'

test('快照从 Turn 事实恢复模型、中断和状态，不将执行字段写入第二份恢复状态', async () => {
  const { store, threadId, turnId, location } = await createThreadStore()
  const createdAt = new Date().toISOString()
  const interrupt = {
    id: createId('interrupt'),
    kind: 'interaction' as const,
    interaction: 'confirm',
    turnId,
    status: 'pending' as const,
    reason: 'confirm action',
    payload: { callId: 'provider-call' },
    resumableWith: ['interaction' as const],
    createdAt,
  }

  await store.turns.update(turnId, { status: 'interrupted', interrupt })
  const record = await readThreadSnapshot(store, threadId, location)

  expect(record).toMatchObject({ turnId, modelId: 'host-model', status: 'interrupted', approvalMode: 'request', interrupt })
  const persisted = (await store.threads.read(threadId))!.state

  expect(persisted).not.toHaveProperty('turnId')
  expect(persisted).not.toHaveProperty('interrupt')
  expect(persisted).not.toHaveProperty('status')
  const publicState = defineThread().toState(record!)

  expect(publicState).not.toHaveProperty('title')
  expect(publicState.runtime.interrupt).toEqual(interrupt)
})

test('并发命名空间增量与上下文更新原子合并，清理一个命名空间不丢其他恢复状态', async () => {
  const { store, threadId, location } = await createThreadStore()
  const summary = { text: 'frozen summary', throughSeq: 2, throughMessageId: 'canonical-summary' }

  await Promise.all([
    updateThreadExtensionState(store, threadId, 'a', { step: 1 }),
    updateThreadExtensionState(store, threadId, 'b', { step: 2 }),
    updateThreadSnapshot(store, threadId, { contextProjection: { summary } }),
  ])
  await updateThreadExtensionState(store, threadId, 'a')
  const record = await readThreadSnapshot(store, threadId, location)

  expect(record?.extensionState).toEqual({ b: { step: 2 } })
  expect(record?.contextProjection.summary).toEqual(summary)
  const publicState = defineThread({ state: state => ({ b: { visible: Boolean(state.b) } }) }).toState(record!)

  expect(publicState.extensions).toEqual({ b: { visible: true } })
  expect(publicState).not.toHaveProperty('extensionState')
  expect(publicState).not.toHaveProperty('contextProjection')
})
