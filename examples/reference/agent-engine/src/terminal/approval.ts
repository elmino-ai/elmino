import type { ToolApprovalInterruptPayload } from '@elmino/tool'
import { createInterface } from 'node:readline/promises'

/** 终端只批准明确确认的调用，其他输入保留待审批状态 */
export async function confirmApproval(payload: ToolApprovalInterruptPayload, signal: AbortSignal) {
  process.stdout.write('\n')
  for (const call of payload.actionRequests)
    console.log('待审批工具：', call.name, call.args)
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await terminal.question('确认执行以上工具吗？输入 y 批准，其他输入暂不执行 ', { signal })
    return answer.trim().toLowerCase() === 'y'
  }
  finally {
    terminal.close()
  }
}
