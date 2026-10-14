import type { Message, ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ToolExecutionContext } from '@elmino/tool'
import type { PendingCall } from './types.js'
import { extractText, toolCalls } from '@elmino/llm'
import { AUTO_APPROVAL_SCHEMA } from '../constants/index.js'
import { AUTO_APPROVAL_SYSTEM_PROMPT } from '../prompts/constants/index.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 使用自动审批模型筛选仍需用户确认的工具调用
 */
export async function autoReview(input: {
  /** 自动审批使用的当前 Turn 模型 */
  model: TurnModel<ModelTurnConfig>
  /** 仍需模型判断的候选工具 */
  calls: PendingCall[]
  /** 当前模型上下文消息 */
  messages: Message[]
  /** 当前工具运行能力 */
  context: Pick<ToolExecutionContext, 'sandbox' | 'signal'>
}) {
  const { calls, context, messages, model } = input
  const { sandbox, signal } = context
  /** 自动审批模型使用的最近上下文摘要 */
  const recent = messages
    .slice(-3)
    .map((message) => {
      const parts: string[] = []
      const text = extractText(message).replace(/\s+/g, ' ').trim()

      if (text)
        parts.push(text.slice(0, 240))

      {
        const calls = toolCalls(message).map(part => part.name)

        if (calls.length)
          parts.push(`tools=${calls.join(', ')}`)
      }

      return {
        role: message.role,
        text: parts.join('\n'),
      }
    })
    .filter(message => message.text)

  try {
    // auto 模式只把候选工具交给评审模型，明确 allow 才会继续执行
    const { object } = await model.adapter.generateObject({
      maxOutputTokens: Math.max(800, calls.length * 160),
      messages: [{
        role: 'user',
        parts: [{ type: 'text', text: JSON.stringify({
          cwd: sandbox.env.cwd,
          recent,
          toolCalls: calls.map(part => ({
            name: part.name,
            args: part.args,
          })),
        }) }],
      }],
      cache: { mode: 'disabled' },
      schema: AUTO_APPROVAL_SCHEMA,
      signal,
      system: [{ type: 'text', text: AUTO_APPROVAL_SYSTEM_PROMPT }],
    })

    if (object.decisions.length !== calls.length)
      throw new Error('自动审批结果数量不匹配')

    return calls.flatMap((part, index) => {
      const review = object.decisions[index]

      if (review?.decision === 'allow')
        return []

      return [{
        ...part,
        approvalReason: review?.reason ?? '无法确定操作风险，请确认后继续',
      }]
    })
  }
  catch (error) {
    if (signal?.aborted)
      throw error

    // 自动审批失败时选择保守策略，把目标工具全部交给用户确认
    return calls.map(part => ({
      ...part,
      approvalReason: '暂时无法评估操作风险，请确认后继续',
    }))
  }
}
