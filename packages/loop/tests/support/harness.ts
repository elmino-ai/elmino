import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { ExecutionHooks, TurnContext, TurnInput } from '@elmino/loop'
import type { Runtime, ThreadLocation } from '@elmino/runtime'
import type { ApprovalMode } from '@elmino/store'
import type { RuntimeEvent } from '@elmino/thread'
import type { DefinedTools } from '@elmino/tool'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineLoop } from '@elmino/loop'
import { createId } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { defineThread, readThreadSnapshot } from '@elmino/thread'
import { defineTools } from '@elmino/tool'
import { onTestFinished } from 'vitest'
import { testFiles } from './files.js'
import { createMockSandbox } from './sandbox.js'
import { testSubagentRole } from './subagent.js'

/** 独立 Loop 验收的真实运行依赖 */
export interface HarnessOptions {
  /** 冻结模型与预设响应 */
  model: TurnModel<ModelTurnConfig>
  /** 直接配置的工具集合 */
  tools?: DefinedTools
  /** 直接配置的执行扩展 */
  hooks?: ExecutionHooks
  /** 当前人机审批模式 */
  approvalMode?: ApprovalMode
  /** 外部取消控制 */
  signal?: AbortSignal
  /** 额外观测事件，可用于检查观察者失败隔离 */
  onEvent?: (event: RuntimeEvent) => Promise<void>
}

/** 用真实存储构造 Loop 的宿主输入，不引用 Agent、Engine 或产品插件 */
export async function createHarness(options: HarnessOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-loop-'))
  const threadId = createId('thread')
  const turnId = createId('turn')
  const location: ThreadLocation = {
    workspaceId: 'workspace_test',
    workspaceKind: 'project',
    workspaceRoot: root,
    dir: '.',
    cwd: root,
  }
  const sandbox = createMockSandbox({ cwd: root })
  const runtime: Runtime = { location, sandbox: () => sandbox, dispose: () => sandbox.shell.dispose() }
  const store = await SqliteStore.create({
    dataDir: path.join(root, 'db'),
    blobStore: LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') }),
  })
  onTestFinished(async () => {
    await runtime.dispose()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  await store.threads.upsert({ id: threadId, dir: '.', agentId: 'test' })
  await store.turns.create({
    id: turnId,
    threadId,
    status: 'running',
    modelConfig: { ...options.model.config },
    subagentRole: testSubagentRole,
    subagentRoles: [testSubagentRole],
    agentSnapshot: { id: 'test', systemPrompt: '' },
    approvalMode: options.approvalMode ?? 'fullAccess',
    subagentMode: 'explicitOnly',
  })
  const events: RuntimeEvent[] = []
  const base: TurnContext = {
    model: options.model,
    approvalMode: options.approvalMode ?? 'fullAccess',
    subagentMode: 'explicitOnly',
    subagentRole: testSubagentRole,
    subagentRoles: [testSubagentRole],
    threadId,
    turnId,
    location,
    signal: options.signal,
    agentId: 'test',
    systemPrompt: [{ type: 'text', text: 'base-system' }],
    hostServices: [],
    tools: options.tools ?? defineTools({}),
    hooks: options.hooks,
    thread: defineThread(),
    services: { runtime, store },
    start: { startsThread: true },
    input: {},
    onRuntimeEvent: async (event) => {
      events.push(event)
      await options.onEvent?.(event)
    },
  }
  const invoke = async (input: TurnInput = {
    messages: [{ message: { role: 'user', parts: [{ type: 'text', text: '执行当前任务' }] } }],
  }) => {
    const snapshot = await readThreadSnapshot(store, threadId, location)
    const result = await defineLoop().invoke({
      ...base,
      input,
      start: { startsThread: events.length === 0, threadSnapshot: snapshot },
    })
    // Loop 返回执行事实，测试宿主承担 Engine 的 Turn 终态事务职责
    await store.turns.update(turnId, {
      status: result.outcome.status,
      interrupt: result.outcome.interrupt ? { ...result.outcome.interrupt } : null,
    })
    return result
  }
  return { root, store, runtime, events, threadId, turnId, invoke, base }
}
