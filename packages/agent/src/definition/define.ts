import type { Agent, AgentDefinition } from './types.js'
import { defineLoop } from '@elmino/loop'
import { defineThread } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
/** 装配默认 Loop 与线程投影，并冻结宿主提供的定义 */
export function defineAgent(definition: AgentDefinition): Agent {
  const tools = definition.tools ?? defineTools({})

  return Object.freeze({
    ...definition,
    name: definition.name ?? definition.id,
    description: definition.description ?? '',
    tools: Object.freeze({
      declarations: structuredClone(tools.declarations),
      handlers: Object.freeze(Object.fromEntries(Object.entries(tools.handlers)
        .map(([name, tool]) => [name, Object.freeze({ ...tool, declaration: structuredClone(tool.declaration) })]))),
    }),
    hooks: definition.hooks ? Object.freeze({ ...definition.hooks }) : undefined,
    loop: definition.loop ?? defineLoop(),
    thread: definition.thread ?? defineThread(),
  })
}
