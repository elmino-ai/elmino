import * as z from 'zod'

/** -------------------- 常量 -------------------- */
/** 自动审批结构化输出格式 */
export const AUTO_APPROVAL_SCHEMA = z.object({
  decisions: z.array(z.object({
    decision: z.enum(['allow', 'ask', 'unsure']),
    reason: z.string().trim().min(1),
  })),
})
