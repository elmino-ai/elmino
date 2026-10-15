/**
 * 人工确认：展示实际待审参数，再把用户选择交回宿主执行流程
 *
 * 只有 y 才表示本次批准；其他输入让示例退出并保留待审批事实
 * 本函数只返回选择，不直接写数据库或执行工具；真正恢复在 engine/run.ts 中完成
 */
import type { ToolApprovalInterruptPayload } from '@elmino/tool'
import { createInterface } from 'node:readline/promises'

/** 终端只批准明确确认的调用，其他输入保留待审批状态 */
export async function confirmApproval(payload: ToolApprovalInterruptPayload, signal: AbortSignal) {
  process.stdout.write('\n')
  // 一次审批可能含多个工具调用，确认前把每个动作及其参数都展示出来
  for (const call of payload.actionRequests)
    console.log('待审批工具：', call.name, call.args)
  // readline 是本次交互持有的资源，成功、超时或输入异常都通过 finally 关闭
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await terminal.question('确认执行以上工具吗？输入 y 批准，其他输入暂不执行 ', { signal })
    return answer.trim().toLowerCase() === 'y'
  }
  finally {
    terminal.close()
  }
}
