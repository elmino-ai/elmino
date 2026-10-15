/**
 * 运行控制阅读路线：创建操作窗口 → 启动 Turn → 提交引导或中断 → 读取最终状态
 *
 * ready 只通知宿主等待工具已经启动；resumeTool 只结束这个演示工具的等待
 * 真正的引导与中断由 app/run.ts 中的 engine.steer / engine.interrupt 完成
 * 等待工具用于确保人能来得及操作，不是引擎工作必需的一层封装
 */
import type { TurnRequest } from '@elmino/engine'
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { RuntimeStore } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import path from 'node:path'
import { AgentEngine } from '@elmino/engine'
import { createId, throwSettledErrors } from '@elmino/shared'
import { sqliteStore } from '@elmino/store-sqlite'
import { createAssistant } from '../agent/agent'

/** 当前活跃 Turn 的宿主操作入口，不另造一层运行控制 API */
export interface ControlTarget {
  /** 显式持有的 Engine */
  engine: AgentEngine
  /** 用于命中当前执行身份的原始请求 */
  request: TurnRequest
  /** 与 Engine 运行相同的工作区 Store */
  store: RuntimeStore
}

/** 终端与测试共用的运行控制装配 */
export interface ControlExampleOptions {
  /** 下含宿主已准备的 workspace */
  dataDir: string
  /** 本次任务的模型 */
  model: TurnModel<ModelTurnConfig>
  /** 工具已开始等待时，宿主直接调用 steer 或 interrupt */
  control: (target: ControlTarget) => Promise<'steer' | 'interrupt'>
  /** 原样传入执行取消信号 */
  signal?: AbortSignal
  /** 当前 Turn 的运行事件 */
  onRuntimeEvent?: (event: RuntimeEvent) => void
}

/** 引导在 Step 边界消费，中断则等待执行结算；两者都准确命中原 Turn */
export async function runControlExample(options: ControlExampleOptions) {
  // 第 1 步：用两个不同信号区分“可以输入了”和“输入已处理，工具可以返回了”
  const ready = Promise.withResolvers<void>()
  const resumeTool = Promise.withResolvers<void>()
  const agent = createAssistant(async (signal) => {
    signal?.throwIfAborted()
    // 停止命令必须能解除工具等待，否则 Engine 会一直等这个工具结束
    const abort = () => resumeTool.reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    ready.resolve()
    try {
      await resumeTool.promise
    }
    // 正常完成或取消都移除监听，避免这个 Turn 退出后仍持有回调
    finally {
      signal?.removeEventListener('abort', abort)
    }
  })
  const lease = await sqliteStore({ dataDir: options.dataDir })()
  const rootDir = path.resolve(options.dataDir, 'workspace')
  const request: TurnRequest = {
    agentId: agent.id,
    threadId: createId('thread'),
    turnId: createId('turn'),
    model: options.model,
    location: { workspaceId: 'example', workspaceKind: 'project', workspaceRoot: rootDir, cwd: rootDir, dir: '.' },
    input: [{ type: 'text', text: '请调用 wait_for_input 等待我的补充需求，然后再回复' }],
    signal: options.signal,
    onRuntimeEvent: options.onRuntimeEvent,
  }
  let engine: AgentEngine | undefined
  const execution = (async () => {
    engine = AgentEngine.create({ [agent.id]: agent })
    // 第 2 步：启动一次真实执行，后续控制始终命中 request 中的原始身份
    const running = engine.run(request, lease.store)
    // 先接住执行成功或拒绝，用户输入期间也可能失败；避免还没 await 就出现未处理拒绝
    const completion = running.completed.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    )
    await running.accepted
    // accepted 不保证模型会调用等待工具；模型直接结束时也必须结束等待窗口
    await Promise.race([ready.promise, completion.then((result) => {
      if (result.status === 'rejected')
        throw result.reason
      throw new Error('模型未调用等待工具，本次没有可操作的运行窗口')
    })])
    // 第 3 步：工具确认已开始等待后才读取输入；回调直接持有 Engine 和同一 Store
    const action = await options.control({ engine, request, store: lease.store })
    // 引导已接纳后，再让当前工具返回；新的要求会在 Step 边界进入下一次模型请求
    resumeTool.resolve()
    const result = await completion
    // 第 4 步：最终状态以存储为准，不能把控制请求成功当作整个任务已经成功
    const turn = await lease.store.turns.read(request.turnId)
    if (!turn)
      throw new Error('执行结束后缺少持久化 Turn')
    // 只有用户主动中断且事实确为 interrupted 才作为预期退出；其他错误继续报告
    if (result.status === 'rejected' && !(action === 'interrupt' && turn.status === 'interrupted'))
      throw result.reason
    if (action === 'steer' && turn.status !== 'completed')
      throw new Error(turn.errorMessage ?? '引导后的任务尚未完成')
    return { threadId: request.threadId, turnId: request.turnId, status: turn.status }
  })()
  // 第 5 步：任务出错、输入失败或用户中断，都先关闭 Engine，再释放存储租约
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
  throwSettledErrors(outcomes, '运行控制示例执行或关闭失败', true)
  if (result.status === 'rejected')
    throw result.reason
  return result.value
}
