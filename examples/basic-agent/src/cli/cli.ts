import type { TurnRequest } from '@elmino/engine'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { extractText } from '@elmino/llm'
import { readThreadInterrupt } from '@elmino/thread'
import { readToolApprovalPayload } from '@elmino/tool'
import { inspectExample, openExampleHost } from '../host/host'
import { createModelConfig, restoreExampleModel } from '../model/model'
import { createSession, readSession } from '../session/session'

/** 每次命令都创建并关闭独立宿主，resume 沿用数据库中的冻结模型和中断 ID */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      'provider': { type: 'string' },
      'approve': { type: 'boolean' },
      'reject': { type: 'boolean' },
    },
  })
  const command = positionals[0]
  if (positionals.length !== 1 || !['start', 'inspect', 'resume'].includes(command ?? '') || !values['data-dir'])
    throw new Error('用法：start|inspect|resume --data-dir <目录>，resume 必须明确指定 --approve 或 --reject')
  if (command === 'resume' ? Boolean(values.approve) === Boolean(values.reject) : values.approve || values.reject)
    throw new Error('仅 resume 接受审批决策，且必须在 --approve 与 --reject 中选择一个')
  if (values.provider && (command !== 'start' || !['demo', 'openai'].includes(values.provider)))
    throw new Error('--provider 仅用于 start，支持 demo 或 openai；恢复使用已有模型配置')
  const config = command === 'start' ? createModelConfig(values.provider === 'openai' ? 'openai' : 'demo') : undefined
  const startingModel = config ? restoreExampleModel(config) : undefined
  const dataDir = path.resolve(values['data-dir'])
  const session = command === 'start' ? await createSession(dataDir) : await readSession(dataDir)
  const host = await openExampleHost(dataDir, session, (event) => {
    if (event.type.startsWith('turn.'))
      console.error(event.type)
  })
  try {
    let text: string | undefined
    if (command !== 'inspect') {
      const turn = command === 'resume' ? await host.store.turns.read(session.turnId) : undefined
      const interrupt = readThreadInterrupt(turn?.interrupt)
      const approval = readToolApprovalPayload(interrupt)
      if (command === 'resume' && (turn?.status !== 'interrupted' || interrupt?.status !== 'pending' || !approval?.actionRequests.length))
        throw new Error('当前运行没有待处理的工具审批，不能重复恢复')
      const modelConfig = config ?? turn?.modelConfig
      if (!modelConfig)
        throw new Error('未找到冻结模型配置')
      const request: TurnRequest = {
        agentId: host.agentId,
        threadId: session.threadId,
        turnId: session.turnId,
        location: host.location,
        model: startingModel ?? restoreExampleModel(modelConfig),
        approvalMode: 'request',
        input: command === 'start' ? [{ type: 'text', text: '请使用 write_note 将 Hello from elmino 写入 result.txt' }] : [],
      }
      if (command === 'resume') {
        request.resume = {
          interruptId: interrupt!.id,
          response: {
            decisions: approval!.actionRequests.map(action => ({
              type: values.approve ? 'approve' : 'reject',
              callId: action.callId,
            })),
          },
        }
      }
      const execution = command === 'start' ? host.engine.run(request, host.store) : host.engine.resume(request, host.store)
      // 两个 Promise 同时接管失败，入口拒绝时 completed 也不会成为未处理 rejection
      const [, message] = await Promise.all([execution.accepted, execution.completed])
      text = message ? extractText(message) : undefined
    }
    const result = await inspectExample(host, session)
    console.log(JSON.stringify({ ...result, text }, null, 2))
    if (result.status === 'failed' || result.status === 'cancelled')
      process.exitCode = 1
  }
  finally {
    await host.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '示例执行失败')
  process.exitCode = 1
})
