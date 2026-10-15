import type { RunAgentOptions, RunAgentResult } from './types'
import path from 'node:path'
import { createId } from '@elmino/shared'
import { AgentEngine } from '../engine/engine'

/** 在新线程运行一次任务，等待结算并释放 Engine，Store 继续由宿主持有 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { agent, store } = options
  const threadId = createId('thread')
  const turnId = createId('turn')
  const workspaceId = options.workspace.id
  const rootDir = path.resolve(options.workspace.rootDir)
  const engine = AgentEngine.create({ [agent.id]: agent })
  let result: RunAgentResult
  try {
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
    result = { threadId, turnId, workspaceId, status: turn.status, errorMessage: turn.errorMessage ?? undefined, message }
  }
  catch (error) {
    try {
      await engine.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], 'Agent 执行和资源关闭均失败')
    }
    throw error
  }
  await engine.close()
  return result
}
