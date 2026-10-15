import type { RuntimeStore, RuntimeStoreLease } from '@elmino/store'
import type { RunAgentOptions, RunAgentResult } from './types'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { AgentEngine } from '../engine/engine'

/** 在新线程运行一次任务，实例 Store 由宿主持有，配置租约随调用释放 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { agent, store: source } = options
  const threadId = createId('thread')
  const turnId = createId('turn')
  const workspaceId = options.workspace.id
  const rootDir = path.resolve(options.workspace.rootDir)
  let engine: AgentEngine | undefined
  let lease: RuntimeStoreLease | undefined
  const execution = (async (): Promise<RunAgentResult> => {
    let store: RuntimeStore
    if (typeof source === 'function') {
      lease = await source(options.signal)
      store = lease.store
    }
    else {
      store = source
    }
    engine = AgentEngine.create({ [agent.id]: agent })
    const message = await engine.run({
      agentId: agent.id,
      threadId,
      turnId,
      model: options.model,
      input: typeof options.input === 'string' ? [{ type: 'text', text: options.input }] : options.input,
      location: {
        workspaceId,
        workspaceKind: 'project',
        workspaceRoot: rootDir,
        cwd: rootDir,
        dir: '.',
      },
      approvalMode: options.approvalMode,
      subagentMode: options.subagentMode,
      signal: options.signal,
      onRuntimeEvent: options.onRuntimeEvent,
    }, store).completed
    const turn = await store.turns.read(turnId)
    if (!turn)
      throw new Error('Agent 执行结束后缺少持久化 Turn')
    const errorMessage = turn.errorMessage ?? undefined
    return { threadId, turnId, workspaceId, status: turn.status, errorMessage, message }
  })()
  const [result] = await Promise.allSettled([execution])
  const errors: unknown[] = []
  try {
    await engine?.close()
  }
  catch (error) {
    errors.push(error)
  }
  try {
    await lease?.release()
  }
  catch (error) {
    errors.push(error)
  }
  if (result.status === 'rejected') {
    if (errors.length > 0)
      throw new AggregateError([result.reason, ...errors], 'Agent 执行和资源关闭均失败')
    throw result.reason
  }
  if (errors.length === 1)
    throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, '关闭 Agent 资源失败')
  return result.value
}
