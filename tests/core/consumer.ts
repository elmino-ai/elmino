/* eslint antfu/no-top-level-await: off -- 仓库外验证不依赖 HTTP 的应用实例 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { defineElmino } from '@elmino/core'
import { extractText } from '@elmino/llm'
import { defineRuntime } from '@elmino/runtime/local'
import { sqliteStore } from '@elmino/store-sqlite'
import { createModel, response } from '../../packages/engine/tests/support/model'
import { createMockSandbox } from '../../packages/loop/tests/support/sandbox'

const writer = defineAgent({
  id: 'writer',
  model: 'primary',
  systemPrompt: '完成本地任务',
  runtime: defineRuntime(({ location }) => createMockSandbox({ cwd: location.cwd })),
})
const model = createModel([response([{ type: 'text', text: 'published core completed' }])])
model.model.config.id = 'primary'
const elmino = defineElmino({
  agents: { writer },
  models: { primary: model.model },
  workspace: { id: 'project', rootDir: process.cwd(), store: sqliteStore({ dataDir: path.resolve('data') }) },
})
try {
  assert.equal(elmino.getAgent('writer'), writer)
  const result = await elmino.run({ agentId: 'writer', input: '从独立 npm 包运行' })
  assert.equal(result.status, 'completed')
  assert.equal(extractText(result.message!), 'published core completed')
  const state = await elmino.getThread({ agentId: 'writer', workspaceId: 'project', threadId: result.threadId })
  assert.equal(state.turns[0]?.id, result.turnId)
  assert.equal(state.turns[0]?.status, 'completed')
}
finally {
  await elmino.close()
}
assert.equal(elmino.closed, true)
await assert.rejects(elmino.run({ agentId: 'writer', input: '关闭后不可执行' }), { code: 'SERVICE_UNAVAILABLE' })
