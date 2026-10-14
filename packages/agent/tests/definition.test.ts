import type { AgentHooks } from '@elmino/agent'
import type { Loop, TurnContext } from '@elmino/loop'
import type { RuntimeDefinition, ThreadLocation } from '@elmino/runtime'
import type { DefinedTools, ToolExecutionContext } from '@elmino/tool'
import { defineAgent } from '@elmino/agent'
import { defineLoop } from '@elmino/loop'
import { createThreadSnapshotRecord, defineThread } from '@elmino/thread'
import { defineTool, defineTools } from '@elmino/tool'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'

/** 不允许静态 Agent 装配阶段创建运行资源 */
const runtime: RuntimeDefinition = {
  create: vi.fn(() => { throw new Error('Agent definition must not create runtime resources') }),
}

/** 不读取本机配置的线程位置 */
const location: ThreadLocation = {
  workspaceId: 'workspace_test',
  workspaceKind: 'project',
  workspaceRoot: '/workspace',
  dir: '.',
  cwd: '/workspace',
}

test('default Agent binds the real Loop and projects persisted thread state', () => {
  const agent = defineAgent({ id: 'agent_test', systemPrompt: 'Original instructions', runtime })
  const snapshot = createThreadSnapshotRecord({
    threadId: 'thread_test',
    agentId: agent.id,
    location,
    extensionState: { private: { value: 'internal' } },
  })
  const state = agent.thread.toState(snapshot)

  expect(agent.name).toBe('agent_test')
  expect(agent.description).toBe('')
  expect(agent.tools.declarations).toEqual([])
  expect(agent.loop.invoke).toBe(defineLoop().invoke)
  expect(state).toMatchObject({ threadId: 'thread_test', workspaceId: 'workspace_test', cwd: '/workspace' })
  expect(state.runtime).toMatchObject({ status: 'idle', agentId: 'agent_test' })
  expect(state.extensions).toEqual({})
  expect(Object.hasOwn(state, 'extensionState')).toBe(false)
  expect(runtime.create).not.toHaveBeenCalled()
})

test('source tool and hook mutations do not change execution or authorization selected by the Agent', async () => {
  const execute = vi.fn((args: { text: string }) => `original:${args.text}`)
  const sourceTools: DefinedTools = defineTools({
    echo: { description: 'Original echo', schema: z.object({ text: z.string() }), execute, approval: 'auto' },
  })
  const beforeTool = vi.fn<NonNullable<AgentHooks['beforeTool']>>(() => ({ decision: 'block', reason: 'original hook' }))
  const hooks: AgentHooks = {
    beforeTool,
    authorizeTool: tool => tool?.declaration.name === 'echo' && tool.declaration.description === 'Original echo'
      ? undefined
      : 'different definition',
  }
  const agent = defineAgent({ id: 'agent_owned', systemPrompt: '', runtime, tools: sourceTools, hooks })
  const sourceTool = sourceTools.handlers.echo!
  const replacement = vi.fn(() => 'replacement')

  sourceTool.execute = replacement
  sourceTool.approval = 'never'
  sourceTool.declaration.name = 'renamed'
  sourceTool.declaration.description = 'Changed description'
  const schemaProperties = sourceTool.declaration.schema.properties as Record<string, Record<string, unknown>>

  schemaProperties.text!.type = 'number'
  sourceTools.handlers.echo = defineTool({ name: 'echo', description: 'Replacement', schema: z.object({}), execute: replacement })
  hooks.beforeTool = vi.fn<NonNullable<AgentHooks['beforeTool']>>(() => ({ decision: 'allow' }))
  hooks.authorizeTool = () => 'replacement hook'
  const selected = agent.tools.handlers.echo!
  const execution: ToolExecutionContext = { sandbox: {} as ToolExecutionContext['sandbox'] }
  const context = { turnId: 'turn_test' } as TurnContext

  expect(selected.execute({ text: 'value' }, execution)).toBe('original:value')
  expect(execute).toHaveBeenCalledWith({ text: 'value' }, execution)
  expect(replacement).not.toHaveBeenCalled()
  expect(selected.approval).toBe('auto')
  expect(agent.hooks?.authorizeTool?.(selected, { text: 'value' }, execution, context)).toBeUndefined()
  expect(selected.declaration.schema).toMatchObject({ properties: { text: { type: 'string' } } })
  expect(agent.tools.declarations[0]).toMatchObject({ name: 'echo', description: 'Original echo' })
  expect(await agent.hooks?.beforeTool?.({ context, part: { type: 'tool-call', id: 'call_test', name: 'echo', args: {} } }))
    .toEqual({ decision: 'block', reason: 'original hook' })
  expect(beforeTool).toHaveBeenCalledOnce()
})

test('explicit Loop, Thread and runtime remain the implementations called by consumers', async () => {
  const context = { turnId: 'turn_custom' } as TurnContext
  const invoke = vi.fn<Loop['invoke']>(input => Promise.resolve({
    outcome: { status: input.turnId === 'turn_custom' ? 'completed' : 'failed' },
  }))
  const loop: Loop = { invoke }
  const thread = defineThread({ state: state => ({ selected: state.custom ?? {} }) })
  const agent = defineAgent({
    id: 'agent_custom',
    name: 'Custom',
    description: 'Custom configuration',
    systemPrompt: '',
    runtime,
    loop,
    thread,
  })
  const snapshot = createThreadSnapshotRecord({
    threadId: 'thread_custom',
    agentId: agent.id,
    location,
    extensionState: { custom: { enabled: true } },
  })

  expect(agent.loop).toBe(loop)
  expect(agent.thread).toBe(thread)
  expect(agent.runtime).toBe(runtime)
  expect(await agent.loop.invoke(context)).toMatchObject({ outcome: { status: 'completed' } })
  expect(invoke).toHaveBeenCalledWith(context)
  expect(agent.thread.toState(snapshot).extensions).toEqual({ selected: { enabled: true } })
})
