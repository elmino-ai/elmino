/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Agent, AgentDefinition, AgentHooks } from '@elmino/agent'
import { defineAgent } from '@elmino/agent'
import { defineRuntime } from '@elmino/runtime/local'
import { defineTools } from '@elmino/tool'
import * as z from 'zod'
import { createMockSandbox } from '../../packages/loop/tests/support/sandbox'

const tools = defineTools({
  echo: { description: 'Echo', schema: z.object({ value: z.string() }), execute: ({ value }) => value },
})
const hooks: AgentHooks = { collectState: () => ({ custom: { value: 1 } }) }
const definition: AgentDefinition = {
  id: 'agent_consumer',
  systemPrompt: 'Use the supplied tools',
  runtime: defineRuntime(() => createMockSandbox()),
  tools,
  hooks,
}
const agent: Agent = defineAgent(definition)
if (agent.name !== definition.id
  || typeof agent.loop.invoke !== 'function'
  || typeof agent.thread.toState !== 'function') {
  throw new Error('默认 Agent 装配不可用')
}
if (!Object.isFrozen(agent) || !Object.isFrozen(agent.tools.handlers.echo) || !Object.isFrozen(agent.hooks))
  throw new Error('Agent 定义没有冻结')
tools.declarations[0]!.description = 'changed after definition'
if (agent.tools.declarations[0]?.description !== 'Echo')
  throw new Error('工具声明没有独立冻结快照')
const runtime = agent.runtime.create({
  agentId: agent.id,
  location: { workspaceId: 'workspace_consumer', workspaceKind: 'project', workspaceRoot: '.', dir: '.', cwd: '.' },
})
try {
  const result = await agent.tools.handlers.echo!.execute({ value: 'published' }, { sandbox: runtime.sandbox() })
  if (result !== 'published')
    throw new Error('Agent 工具不能在宿主环境中执行')
}
finally { await runtime.dispose() }
