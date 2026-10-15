import type { ExecutionHooks, Loop, ToolResumeResult } from '@elmino/loop'
import { defineLoop, estimateTokens, resolveLoopInteraction } from '@elmino/loop'

const loop: Loop = defineLoop()
const hooks: ExecutionHooks = {
  collectState: () => ({ custom: { value: 1 } }),
  processMessages: ({ messages }) => messages,
}
const resumed: ToolResumeResult = { callId: 'call_consumer', output: 'ok' }
if (typeof loop.invoke !== 'function' || !hooks.collectState || resumed.output !== 'ok')
  throw new Error('执行入口和扩展契约不可用')
if (estimateTokens('abcd').tokens !== 1)
  throw new Error('上下文估算不可用')
const result = resolveLoopInteraction({
  id: 'interrupt_consumer',
  kind: 'interaction',
  interaction: 'tool_approval',
  status: 'pending',
  turnId: 'turn_consumer',
  reason: 'approval',
  createdAt: new Date().toISOString(),
  resumableWith: ['interaction'],
  payload: {
    actionRequests: [{ callId: 'call_consumer', name: 'echo', args: {} }],
    reviewConfigs: [{ actionName: 'echo', allowedDecisions: ['approve'] }],
  },
}, { decisions: [{ callId: 'call_consumer', type: 'approve' }] })
if (!result)
  throw new Error('打包后的审批恢复不可用')
