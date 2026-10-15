/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Runtime, RuntimeDefinition, ThreadLocation } from '@elmino/runtime'
import { defineRuntime } from '@elmino/runtime/local'
import { createMockSandbox } from '../../packages/loop/tests/support/sandbox'

let disposed = 0
const sandbox = createMockSandbox({
  dispose: () => {
    disposed++
    return Promise.resolve()
  },
})
const definition: RuntimeDefinition = defineRuntime(() => sandbox)
const location: ThreadLocation = {
  workspaceId: 'workspace_consumer',
  workspaceKind: 'project',
  workspaceRoot: '.',
  dir: '.',
  cwd: '.',
}
const runtime: Runtime = definition.create({ agentId: 'agent_consumer', location })
if (runtime.sandbox() !== sandbox)
  throw new Error('Runtime 无法持有宿主环境')
await Promise.all([runtime.dispose(), runtime.dispose()])
if (disposed !== 1)
  throw new Error('Runtime 未幂等释放')
let rejected = false
try {
  runtime.sandbox()
}
catch { rejected = true }
if (!rejected)
  throw new Error('Runtime 关闭后仍接纳新环境获取')
