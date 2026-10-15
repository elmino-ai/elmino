import type { Thread, ThreadSnapshotRecord } from '@elmino/thread'
import { createRuntimeEvent, createThreadSnapshotRecord, defineThread, readThreadInteraction } from '@elmino/thread'

const snapshot: ThreadSnapshotRecord = createThreadSnapshotRecord({
  threadId: 'thread_consumer',
  agentId: 'agent_consumer',
  location: { workspaceId: 'workspace_consumer', workspaceKind: 'project', workspaceRoot: '.', dir: '.', cwd: '.' },
  extensionState: { custom: { value: 1 } },
})
const thread: Thread = defineThread({ state: state => state })
const state = thread.toState(snapshot)
if (state.extensions.custom?.value !== 1 || state.workspaceId !== 'workspace_consumer')
  throw new Error('线程快照和宿主状态映射不可用')
const event = createRuntimeEvent({ type: 'thread.updated', threadId: snapshot.threadId, payload: state })
if (event.type !== 'thread.updated')
  throw new Error('运行事件不可用')
const interrupt = readThreadInteraction({
  id: 'interrupt_consumer',
  kind: 'user',
  reason: 'cancelled',
  status: 'pending',
  turnId: 'turn_consumer',
  createdAt: new Date().toISOString(),
  resumableWith: ['message'],
})
if (interrupt)
  throw new Error('非交互中断被误识别')
