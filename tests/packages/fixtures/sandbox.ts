import type { SandboxApprovalReview, SandboxReviewInput, SandboxScopeReview } from '@elmino/sandbox'
import { SANDBOX_READ_MAX_BYTES } from '@elmino/sandbox'

const request: SandboxReviewInput = { kind: 'shell', command: 'echo ok' }
const approval: SandboxApprovalReview = { decision: 'allow' }
const scope: SandboxScopeReview = { scope: 'inspect' }
if (request.kind !== 'shell' || approval.decision !== 'allow' || scope.scope !== 'inspect')
  throw new Error('审批契约不可用')
if (SANDBOX_READ_MAX_BYTES <= 0)
  throw new Error('文件边界常量不可用')
