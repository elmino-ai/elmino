import type { TurnRequest } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { Promisable, UnknownRecord } from '@elmino/shared'
import type { RuntimeEvent } from '@elmino/thread'
import type { ToolApprovalInterruptPayload } from '@elmino/tool'
import path from 'node:path'
import { AgentEngine } from '@elmino/engine'
import { createId, throwSettledErrors } from '@elmino/shared'
import { sqliteStore } from '@elmino/store-sqlite'
import { readThreadInteraction, readThreadInterrupt } from '@elmino/thread'
import { readToolApprovalPayload } from '@elmino/tool'
import { writer } from '../agent/agent'

/** AgentEngine API 参考所需的宿主能力，测试可注入模型与审批结果 */
export interface EngineExampleOptions {
  /** 独立数据目录，工作区已由宿主创建 */
  dataDir: string
  /** 新任务创建模型，恢复时按原 Turn 的冻结配置重建 */
  model: (frozenConfig?: UnknownRecord) => TurnModel<ModelTurnConfig>
  /** 用户确认全部待审调用；不批准则保留中断，暂不恢复 */
  approve: (payload: ToolApprovalInterruptPayload) => Promisable<boolean>
  /** 两轮对话和恢复共用的运行事件出口 */
  onRuntimeEvent?: (event: RuntimeEvent) => Promisable<void>
  /** 宿主控制整次示例的取消与超时 */
  signal?: AbortSignal
}

/** 在同一线程运行两轮，重建 Engine 后读取持久化审批并恢复原 Turn */
export async function runEngineExample(options: EngineExampleOptions) {
  const rootDir = path.resolve(options.dataDir, 'workspace')
  const threadId = createId('thread')
  const firstTurnId = createId('turn')
  const turnId = createId('turn')
  const lease = await sqliteStore({ dataDir: options.dataDir })()
  const { store } = lease
  let engine: AgentEngine | undefined
  const execution = (async () => {
    engine = AgentEngine.create({ writer })
    const request: TurnRequest = {
      agentId: writer.id,
      threadId,
      turnId: firstTurnId,
      model: options.model(),
      location: { workspaceId: 'example', workspaceKind: 'project', workspaceRoot: rootDir, cwd: rootDir, dir: '.' },
      input: [{ type: 'text', text: '请记住本次便签的完整内容是 Hello from elmino，暂时不要调用工具，只确认记住' }],
      approvalMode: 'request',
      signal: options.signal,
      onRuntimeEvent: options.onRuntimeEvent,
    }
    const first = engine.run(request, store)
    await first.accepted
    await first.completed
    const firstTurn = await store.turns.read(firstTurnId)
    if (firstTurn?.status !== 'completed')
      throw new Error(firstTurn?.errorMessage ?? '第一轮未完成')

    // 同一个 threadId 延续历史，每次 run 都使用新的 turnId
    const second = engine.run({
      ...request,
      turnId,
      input: [{ type: 'text', text: '现在请调用 write_note，将上一轮记住的完整便签内容写入 result.txt' }],
    }, store)
    await second.accepted
    await second.completed

    // 模拟宿主重建引擎，Store 继续由本示例持有
    await engine.close()
    engine = AgentEngine.create({ writer })
    await engine.recoverWorkspace({ agentId: writer.id, store, threadLocation: () => request.location })
    const pending = await store.turns.read(turnId)
    const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))
    const payload = readToolApprovalPayload(interrupt)
    if (pending?.status !== 'interrupted' || !interrupt || !payload)
      throw new Error(pending?.errorMessage ?? '第二轮未产生预期的工具审批中断')
    if (!await options.approve(payload))
      return { threadId, firstTurnId, turnId, status: pending.status }

    // 恢复沿用原 threadId、turnId、interruptId，以及持久化的模型配置
    const resumed = engine.resume({
      ...request,
      turnId,
      input: [],
      model: options.model(pending.modelConfig),
      resume: {
        interruptId: interrupt.id,
        response: { decisions: payload.actionRequests.map(call => ({ type: 'approve', callId: call.callId })) },
      },
    }, store)
    await resumed.accepted
    const message = await resumed.completed
    const turn = await store.turns.read(turnId)
    if (turn?.status !== 'completed')
      throw new Error(turn?.errorMessage ?? '审批恢复后任务尚未完成')
    return { threadId, firstTurnId, turnId, status: turn.status, message }
  })()
  const [result] = await Promise.allSettled([execution])
  const outcomes: PromiseSettledResult<unknown>[] = [result]
  try {
    await engine?.close()
  }
  catch (reason) {
    outcomes.push({ status: 'rejected', reason })
  }
  try {
    await lease.release()
  }
  catch (reason) {
    outcomes.push({ status: 'rejected', reason })
  }
  throwSettledErrors(outcomes, 'AgentEngine 示例执行或资源关闭失败', true)
  if (result.status === 'rejected')
    throw result.reason
  return result.value
}
