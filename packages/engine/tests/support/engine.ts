import type { Agent, AgentHooks } from '@elmino/agent'
import type { AgentEngineOptions, TurnRequest } from '@elmino/engine'
import type { ModelTurnConfig, Provider, TurnModel } from '@elmino/llm'
import type { TurnContext, TurnResult } from '@elmino/loop'
import type { ThreadLocation } from '@elmino/runtime'
import type { RuntimeStore } from '@elmino/store'
import type { ThreadInteractionInterrupt } from '@elmino/thread'
import type { AuxiliaryQueue, SubagentController } from '@elmino/tool'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine, getBuiltinSubagentRoles } from '@elmino/engine'
import { LocalRuntime } from '@elmino/runtime/local'
import { createId, delay } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { auxQueueHostService, createHostServices, subagentHostService } from '@elmino/tool'
import dayjs from 'dayjs'
import { test } from 'vitest'
import { testFiles } from './files'
import { createTestSandbox } from './sandbox'

/** -------------------- 类型 -------------------- */
/** 自定义 Loop 接收 Engine 真正注入的控制服务 */
export interface TestTurnContext extends TurnContext {
  /** 辅助任务调度控制服务 */
  testAuxQueue?: AuxiliaryQueue
  /** 只在根 Turn 提供的子智能体控制面 */
  testSubagents?: SubagentController
}

/** -------------------- 常量 -------------------- */
/** 当前能力测试使用的冻结内置角色目录 */
export const testSubagentRoles = getBuiltinSubagentRoles()
/** 当前能力测试使用的根角色 */
export const testSubagentRole = testSubagentRoles[0]!
/** 控制生命周期测试不调用模型生成，仅保持真实 Provider 契约 */
export const adapter: Provider = {
  name: 'test',
  model: 'test-model',
  capabilities: { cache: { modes: ['disabled'] }, reasoning: true, tools: true, jsonSchema: true },
  generate: () => Promise.reject(new Error('控制流测试不调用 Provider')),
  stream: () => Promise.reject(new Error('控制流测试不调用 Provider')),
  generateObject: (() => Promise.reject(new Error('控制流测试不调用 Provider'))) as Provider['generateObject'],
}
/** 子智能体模型继承断言使用的同一冻结模型 */
export const turnModel: TurnModel<ModelTurnConfig> = {
  config: {
    id: 'model_4c9d83a5-9ff6-439a-b264-68fd4bec0355',
    providerId: 'provider_11da3428-7354-4536-918d-09c6caf6bc70',
    providerName: 'anthropic',
    name: 'test-model',
    label: 'Test Model',
    apiFormat: 'anthropic-messages',
    baseURL: 'https://example.com/anthropic',
    cache: { mode: 'disabled' },
    limit: { context: 1_000_000 },
    jsonSchema: true,
    inputModalities: [],
  },
  adapter,
}
/** 需要真实 POSIX 进程语义的测试 */
export const posixTest = process.platform === 'win32' ? test.skip : test
/** 控制测试用真实宿主 Interaction 解析，不引入插件容器 */
export const testResumeHooks: AgentHooks = {
  resolveInteraction: ({ interrupt, response }) => (
    interrupt.ownerId === 'test.resume' && interrupt.interaction === 'resume' && response === 'continue'
      ? { action: 'resume', response }
      : undefined
  ),
}

/** -------------------- 核心函数 -------------------- */
/**
 * 从标签派生稳定测试实体 ID，用于中断严格恢复入口
 */
export function testId(prefix: 'interrupt' | 'turn', name: string) {
  const hash = createHash('sha256').update(`${prefix}:${name}`).digest('hex')
  return `${prefix}_${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/**
 * 构造没有 sampling 响应的已完成控制执行结果
 */
export function completedTurnResult(): TurnResult {
  return { outcome: { status: 'completed' } }
}

/**
 * 创建使用真实 Runtime 与冻结角色目录的测试 Engine
 */
export function createEngine(agent: Agent, options: Partial<AgentEngineOptions> = {}) {
  return AgentEngine.create({ [agent.id]: agent }, {
    createRuntime: (target, context) => target.runtime.create({ agentId: target.id, ...context }),
    resolveSubagentRoles: () => Promise.resolve(testSubagentRoles),
    ...options,
  })
}

/**
 * 创建拥有真实 Sandbox 且由 Engine 管理释放的 Runtime
 */
export function createTestRuntime(location: ThreadLocation = turnRequest('thread-test', 'turn-test').location) {
  return LocalRuntime.create({ location, sandbox: createTestSandbox({ cwd: location.cwd, allowedRoots: [location.workspaceRoot] }) })
}

/**
 * 用自定义 Loop 验证调度，控制服务仍由实际 Engine 提供
 */
export function createAgent(
  invoke: (context: TestTurnContext) => Promise<TurnResult>,
  hooks: AgentHooks = testResumeHooks,
): Agent {
  return defineAgent({
    id: 'code',
    name: 'Test Agent',
    description: 'Lifecycle test',
    systemPrompt: 'test',
    hooks,
    loop: {
      invoke: (options) => {
        const services = createHostServices(options.hostServices)
        return invoke({
          ...options,
          testAuxQueue: services.require(auxQueueHostService),
          testSubagents: options.parentThreadId ? undefined : services.require(subagentHostService),
        })
      },
    },
    runtime: { create: context => createTestRuntime(context.location) },
  })
}

/**
 * 构造带宿主执行位置的统一 Turn 请求
 */
export function turnRequest(threadId: string, turnId: string): TurnRequest {
  return {
    threadId,
    turnId,
    location: {
      workspaceId: 'default',
      workspaceKind: 'managed',
      workspaceRoot: '/tmp/elmino-agent-engine',
      dir: '.',
      cwd: '/tmp/elmino-agent-engine',
    },
    model: turnModel,
    agentId: 'code',
    approvalMode: 'auto',
    input: [],
  }
}

/**
 * 构造当前宿主可恢复的待决 Interaction
 */
export function testResumeInterrupt(turnId: string, ownerId = 'test.resume'): ThreadInteractionInterrupt {
  return {
    id: testId('interrupt', turnId),
    kind: 'interaction',
    interaction: 'resume',
    ownerId,
    status: 'pending',
    turnId,
    reason: '等待测试恢复',
    payload: {},
    createdAt: '2026-06-25T00:00:00.000Z',
    resumableWith: ['interaction'],
  }
}

/**
 * 将待决 Interaction 交回 Engine 持久结算
 */
export function interruptedTurnResult(turnId: string, ownerId = 'test.resume'): TurnResult {
  return { outcome: { status: 'interrupted', interrupt: testResumeInterrupt(turnId, ownerId) } }
}

/**
 * 构造严格命中持久中断 ID 的恢复请求
 */
export function resumableTurnRequest(threadId: string, turnId: string): TurnRequest {
  return { ...turnRequest(threadId, turnId), resume: { interruptId: testId('interrupt', turnId), response: 'continue' } }
}

/**
 * 从持久线程目录恢复实际执行位置
 */
export function resolveTestThreadLocation(workspaceRoot = '/tmp/elmino-agent-engine') {
  return (thread: { id: string, dir: string }) => Promise.resolve({
    workspaceId: 'default',
    workspaceKind: 'managed' as const,
    workspaceRoot,
    dir: thread.dir,
    cwd: path.resolve(workspaceRoot, thread.dir),
  })
}

/**
 * 为控制测试创建独立的真实 SQLite 与内容存储
 */
export async function createEngineStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'elmino-agent-engine-'))
  const store = await SqliteStore.create({
    dataDir: path.join(root, 'db'),
    blobStore: LocalBlobStore.create({ files: testFiles, rootDir: path.join(root, 'blobs') }),
  })
  return { root, store }
}

/**
 * 关闭测试 Store 后只清理本次创建的叶子目录
 */
export async function disposeEngineStore(root: string, store: RuntimeStore) {
  await store.close()
  await rm(root, { force: true, recursive: true })
}

/**
 * 等待指定父 Turn 的全部派生 Turn 进入稳定终态
 */
export async function waitForChildTurns(store: RuntimeStore, parentTurnId: string) {
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const edges = await store.turnSpawnEdges.listChildren(parentTurnId)
    const turns = await Promise.all(edges.map(edge => store.turns.read(edge.childTurnId)))
    if (turns.every(turn => turn && terminalStatuses.has(turn.status)))
      return
    await delay(1)
  }
  throw new Error(`等待子任务终态超时: ${parentTurnId}`)
}

/**
 * 创建完整父 Turn 与工具归属事实，避免测试绕过真实外键和派生关系
 */
export async function seedParentTurn(
  store: RuntimeStore,
  threadId: string,
  turnId: string,
  toolCallIds: string[],
  subagentMode: 'explicitOnly' | 'proactive' = 'explicitOnly',
) {
  const now = dayjs().toISOString()
  await store.threads.upsert({
    dir: '.',
    agentId: 'code',
    id: threadId,
    status: 'interrupted',
    metadata: { workspaceRoot: '/tmp/elmino-agent-engine', cwd: '/tmp/elmino-agent-engine', workspaceId: 'default' },
    state: { contextProjection: {} },
  })
  await store.turns.create({
    id: turnId,
    threadId,
    subagentRole: testSubagentRole,
    subagentRoles: testSubagentRoles,
    status: 'interrupted',
    modelConfig: { ...turnModel.config },
    agentSnapshot: { id: 'code', systemPrompt: '' },
    approvalMode: 'auto',
    subagentMode,
    createdAt: now,
    startedAt: now,
  })
  await store.turns.update(turnId, { interrupt: { ...testResumeInterrupt(turnId) } })
  const messageId = createId('msg')
  const partIds = toolCallIds.map(() => createId('part'))
  await store.transcript.upsert({
    id: messageId,
    threadId,
    turnId,
    role: 'assistant',
    kind: 'normal',
    status: 'streaming',
    parts: toolCallIds.map((id, index) => ({
      id: partIds[index]!,
      messageId,
      threadId,
      turnId,
      seq: index + 1,
      type: 'tool',
      status: 'running',
      toolCallId: id,
      providerCallId: `toolu_${id}`,
      toolName: 'spawnSubagent',
      args: { name: `Child ${index + 1}` },
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
    metadata: {},
  })
  for (const [index, id] of toolCallIds.entries()) {
    await store.toolCalls.create({
      id,
      turnId,
      assistantMessageId: messageId,
      assistantPartId: partIds[index]!,
      providerCallId: `toolu_${id}`,
      name: 'spawnSubagent',
      args: { name: `Child ${index + 1}` },
      status: 'running',
    })
  }
}
