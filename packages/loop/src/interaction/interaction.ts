import type { JsonValue } from '@elmino/shared'
import type { ThreadInteractionInterrupt } from '@elmino/thread'
import { readToolApprovalPayload, readToolApprovalResponse } from '@elmino/tool'

/** -------------------- 核心函数 -------------------- */
/**
 * 校验 Loop 内置 Interaction 并返回归一化响应
 */
export function resolveLoopInteraction(
  interrupt: ThreadInteractionInterrupt,
  response: JsonValue,
): JsonValue | undefined {
  const payload = readToolApprovalPayload(interrupt)

  if (!payload)
    return

  return readToolApprovalResponse(response, payload) as unknown as JsonValue
}
