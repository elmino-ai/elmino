import { createPromptTemplate } from '@elmino/shared'
import { readPromptTemplate } from '@elmino/shared/node'

/** -------------------- 审批 Prompt -------------------- */
/** 自动审批系统提示词 */
export const AUTO_APPROVAL_SYSTEM_PROMPT = readPromptTemplate(
  new URL('../template/approval/auto-approval-system.md', import.meta.url),
)

/** -------------------- 压缩 Prompt -------------------- */
/** 上下文压缩摘要提示词 */
export const CONTEXT_COMPACTION_SUMMARY_PROMPT = createPromptTemplate<{
  conversation: string
}>({
  template: readPromptTemplate(
    new URL('../template/compact/context-compaction-summary.md', import.meta.url),
  ),
  inputVariables: ['conversation'],
})

/** -------------------- 恢复 Prompt -------------------- */
/** 输出截断后的续写提示 */
export const CONTINUATION_PROMPT = readPromptTemplate(
  new URL('../template/recovery/continuation.md', import.meta.url),
)

/** 空可见回复后的隐藏纠偏提示 */
export const EMPTY_RESPONSE_REMINDER_PROMPT = readPromptTemplate(
  new URL('../template/recovery/empty-response-reminder.md', import.meta.url),
)
