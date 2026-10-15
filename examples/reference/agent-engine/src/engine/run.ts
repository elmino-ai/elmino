/**
 * AgentEngine 的完整生命周期：按下面六个步骤阅读
 *
 * 1. 借用存储并创建 Engine；2. 在同一线程中执行两轮；3. 第二轮等待工具审批
 * 4. 关闭并重建 Engine；5. 从 Store 读取原中断并恢复；6. 结算后按所有权释放
 * 演示的是同一进程内重建 Engine，Store 始终打开，不等同于跨进程续接 CLI
 */
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
  // 第 1 步：线程身份贯穿两轮，每轮各有自己的 Turn 身份；不要复用 turnId 创建新任务
  const threadId = createId('thread')
  const firstTurnId = createId('turn')
  const turnId = createId('turn')
  // 高级入口由宿主显式借用 Store；与 runAgent 不同，这里要亲自安排最终 release
  const lease = await sqliteStore({ dataDir: options.dataDir })()
  const { store } = lease
  let engine: AgentEngine | undefined
  // 把执行与清理结果分开收集，执行失败后仍能关闭 Engine、释放存储并保留所有错误
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
    // 第 2 步：accepted 是接纳确认，completed 才等待模型、工具和本轮结算完成
    const first = engine.run(request, store)
    await first.accepted
    await first.completed
    // completed 也可能以 failed/interrupted 状态结算，因此仍需读取持久化状态
    const firstTurn = await store.turns.read(firstTurnId)
    if (firstTurn?.status !== 'completed')
      throw new Error(firstTurn?.errorMessage ?? '第一轮未完成')

    // 同一个 threadId 延续历史，每次 run 都使用新的 turnId
    // 第 3 步：第一轮结束后再启动第二轮，复用 threadId 才能让模型读取先前历史
    const second = engine.run({
      ...request,
      turnId,
      input: [{ type: 'text', text: '现在请调用 write_note，将上一轮记住的完整便签内容写入 result.txt' }],
    }, store)
    await second.accepted
    await second.completed

    // 模拟宿主重建引擎，Store 继续由本示例持有
    // 第 4 步：旧 Engine 先退出，新的 Engine 再接管；不要让两套执行器并发控制同一运行
    await engine.close()
    engine = AgentEngine.create({ writer })
    await engine.recoverWorkspace({ agentId: writer.id, store, threadLocation: () => request.location })
    // 新 Engine 不会凭终端变量重建审批；从 Store 读取当前仍有效的 interruptId 和工具参数
    const pending = await store.turns.read(turnId)
    const interrupt = readThreadInteraction(readThreadInterrupt(pending?.interrupt))
    const payload = readToolApprovalPayload(interrupt)
    if (pending?.status !== 'interrupted' || !interrupt || !payload)
      throw new Error(pending?.errorMessage ?? '第二轮未产生预期的工具审批中断')
    // 暂不批准表示保留中断后退出，不等同于向模型提交 reject 决策
    if (!await options.approve(payload))
      return { threadId, firstTurnId, turnId, status: pending.status }

    // 恢复沿用原 threadId、turnId、interruptId，以及持久化的模型配置
    // 第 5 步：resume 恢复原执行，所以三个身份都沿用；工具决策按 Provider callId 匹配
    const resumed = engine.resume({
      ...request,
      turnId,
      input: [],
      // 恢复原模型配置并重新注入凭据，不能直接选用当前环境中的另一个默认模型
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
  // 第 6 步：先等执行结算，再关闭当前 Engine，最后释放租约；任一失败都不跳过后续清理
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
