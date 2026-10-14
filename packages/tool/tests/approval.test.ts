import type { JsonValue } from '@elmino/shared'
import type { ToolApprovalInterruptPayload } from '@elmino/tool'
import { readToolApprovalPayload, readToolApprovalResponse } from '@elmino/tool'
import { expect, test } from 'vitest'

/** 按调用 ID 与允许决策冻结的审批载荷 */
const payload: ToolApprovalInterruptPayload = {
  actionRequests: [{ callId: 'first', name: 'write', args: { path: '/file' } }, { callId: 'second', name: 'read', args: {} }],
  reviewConfigs: [{ actionName: 'write', allowedDecisions: ['approve', 'edit', 'reject'] }, { actionName: 'read', allowedDecisions: ['approve'] }],
}

test('approval payload is accepted only for valid tool approval interactions', () => {
  expect(readToolApprovalPayload({ kind: 'interaction', interaction: 'tool_approval', payload })).toEqual(payload)
  expect(readToolApprovalPayload({ kind: 'interaction', interaction: 'other', payload })).toBeUndefined()
  expect(readToolApprovalPayload({ kind: 'other', interaction: 'tool_approval', payload })).toBeUndefined()
  expect(readToolApprovalPayload({ kind: 'interaction', interaction: 'tool_approval', payload: { actionRequests: [], reviewConfigs: [{}] } })).toBeUndefined()
})

test('approval responses require one authorized decision per pending call ID', () => {
  const decisions: JsonValue[] = [{ type: 'approve', callId: 'second' }, { type: 'reject', callId: 'first', message: 'declined' }]

  expect(readToolApprovalResponse({ decisions }, payload)).toEqual({ decisions })
  expect(readToolApprovalResponse({ decisions: [{ type: 'approve', callId: 'first' }] }, payload)).toBeUndefined()
  expect(readToolApprovalResponse({ decisions: [{ type: 'approve', callId: 'first' }, { type: 'approve', callId: 'first' }] }, payload)).toBeUndefined()
  expect(readToolApprovalResponse({ decisions: [{ type: 'approve', callId: 'first' }, { type: 'respond', callId: 'second', message: 'answer' }] }, payload)).toBeUndefined()
})

test('edited approval decisions require complete JSON arguments', () => {
  const decisions: JsonValue[] = [{ type: 'edit', callId: 'first', editedAction: { name: 'write', args: { path: '/other' } } }, { type: 'approve', callId: 'second' }]

  expect(readToolApprovalResponse({ decisions }, payload)).toEqual({ decisions })
  expect(readToolApprovalResponse({ decisions: [{ type: 'edit', callId: 'first', editedAction: { name: 'write' } }, { type: 'approve', callId: 'second' }] }, payload)).toBeUndefined()
})
