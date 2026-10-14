import type { StepResult } from '../step/types.js'
import type { TurnContext, TurnResult } from '../types/index.js'
import { executeStep } from '../step/execute.js'
import { resumeBatch } from '../tool/resume.js'
import { startTurn } from './start.js'

/** -------------------- 核心函数 -------------------- */
/**
 * 执行一个完整 Turn，直到完成、中断或失败
 */
export async function executeTurn(context: TurnContext): Promise<TurnResult> {
  const turn = await startTurn(context)

  /** 从已经落盘的终态生成 Turn 结果 */
  const result = (step?: StepResult): TurnResult => {
    return {
      response: step?.message,
      outcome: turn.snapshots.readOutcome(),
    }
  }

  try {
    const resumeAction = context.input.resume
      ? await resumeBatch(turn, context.input.resume)
      : 'none'

    if (resumeAction === 'stop')
      return result()

    while (true) {
      const step = await executeStep(turn)
      const status = step.action === 'stop'
        ? turn.snapshots.readOutcome().status
        : undefined
      const steering = context.steering
        ? await context.steering.afterStep(status)
        : []

      if (steering.length > 0) {
        const messages = steering.map(item => item.message)

        turn.state.contextMessages.push(...messages)
        await turn.hooks.onLifecycle?.('user.prompt.submit', {
          context,
          signal: context.signal,
          payload: { messages },
        })
        continue
      }

      if (step.action === 'continue')
        continue

      if (turn.snapshots.readOutcome().status === 'completed') {
        await turn.hooks.onLifecycle?.('turn.completed', {
          context,
          signal: context.signal,
          payload: {
            messages: [...turn.state.contextMessages],
            response: step.message,
          },
        })
      }

      return result(step)
    }
  }
  finally {
    await turn.dispose()
  }
}
