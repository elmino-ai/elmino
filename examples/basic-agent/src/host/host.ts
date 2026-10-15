import type { RuntimeEvent } from '@elmino/thread'
import type { ExampleSession } from '../session/session'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { createEnv, LocalEnv, resolveLocalShell } from '@elmino/local'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'
import { throwSettledErrors } from '@elmino/shared'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'
import { readThreadInterrupt } from '@elmino/thread'
import { defineTools, readToolApprovalPayload } from '@elmino/tool'
import * as z from 'zod'
import { restoreExampleModel } from '../model/model'

/** 装配真实存储、运行环境和 Agent，宿主拥有 Store，Engine 拥有线程 Runtime */
export async function openExampleHost(dataDir: string, session: ExampleSession, onEvent?: (event: RuntimeEvent) => void) {
  const workspaceRoot = path.join(dataDir, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  // 示例复制当前启动环境，不执行登录 Shell；应用需要时可注入 loadUserEnv
  const environment = LocalEnv.create({ shell: createEnv(process.env) })
  const blobStore = LocalBlobStore.create({
    rootDir: path.join(dataDir, 'blobs'),
    files: {
      async exists(file) {
        try {
          await access(file)
          return true
        }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return false
          throw error
        }
      },
      readBytes: file => readFile(file),
      async writeBytes(file, content) {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
        return {}
      },
    },
  })
  const store = await SqliteStore.create({ dataDir: path.join(dataDir, 'database'), blobStore })
  try {
    const agent = defineAgent({
      id: 'basic-agent',
      systemPrompt: '使用 write_note 将用户要求的内容写入 result.txt，写入成功后报告结果，不重复执行工具',
      tools: defineTools({
        write_note: {
          description: '将文字写入当前工作区的 result.txt 并保存为产物',
          schema: z.object({ text: z.string().min(1) }),
          scope: 'modify',
          approval: 'auto',
          async execute({ text }, { sandbox }) {
            const result = await sandbox.files.write('result.txt', text)
            if (result.error)
              throw new Error(result.error)
            const artifact = await store.artifacts.write({
              id: session.artifactId,
              threadId: session.threadId,
              contentKind: 'bytes',
              contentBytes: new TextEncoder().encode(text),
              mimeType: 'text/plain',
            })
            return JSON.stringify({ path: result.path, artifactId: artifact.id })
          },
        },
      }),
      runtime: defineRuntime(({ location }) => {
        const env = environment.snapshot()
        return LocalSandbox.create({
          cwd: location.cwd,
          env,
          shell: resolveLocalShell({ env, accountShell: null }),
          resolveShell: (kind, env) => resolveLocalShell({ env, accountShell: null, preference: kind }),
        })
      }),
    })
    const engine = AgentEngine.create({ [agent.id]: agent }, {
      restoreModel: config => Promise.resolve(restoreExampleModel(config)),
      onRuntimeEvent: (_agentId, event) => onEvent?.(event),
    })
    return {
      engine,
      store,
      blobStore,
      agentId: agent.id,
      location: {
        workspaceId: session.workspaceId,
        workspaceKind: 'project' as const,
        workspaceRoot,
        cwd: workspaceRoot,
        dir: '.',
      },
      async close() {
        // 先排空引擎，再关闭注入存储；保留两阶段可能出现的全部关闭错误
        const engineResults = await Promise.allSettled([engine.close()])
        const storeResults = await Promise.allSettled([store.close()])
        throwSettledErrors([...engineResults, ...storeResults], '关闭示例资源失败', true)
      },
    }
  }
  catch (error) {
    const results = await Promise.allSettled([Promise.reject(error), store.close()])
    throwSettledErrors(results, '装配示例失败', true)
    throw error
  }
}

/** 只从持久化事实与真实文件读取状态，检查时不恢复模型或提交新的运行 */
export async function inspectExample(host: Awaited<ReturnType<typeof openExampleHost>>, session: ExampleSession) {
  const turn = await host.store.turns.read(session.turnId)
  if (!turn)
    throw new Error('未找到示例运行，请检查数据目录或重新选择目录运行 start')
  const artifact = await host.store.artifacts.read(session.artifactId)
  const calls = await host.store.toolCalls.list({ turnId: session.turnId })
  const steps = await host.store.steps.list(session.turnId)
  const interrupt = readThreadInterrupt(turn.interrupt)
  const approval = readToolApprovalPayload(interrupt)
  let file: string | null = null
  try {
    file = await readFile(path.join(host.location.cwd, 'result.txt'), 'utf8')
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
  return {
    ...session,
    status: turn.status,
    error: turn.errorMessage,
    pending: approval?.actionRequests ?? [],
    steps: steps.map(step => step.status),
    tools: calls.map(call => ({ name: call.name, status: call.status, decision: call.decision })),
    file,
    artifact: artifact?.blobKey
      ? { id: artifact.id, storage: artifact.storage, content: new TextDecoder().decode(await host.blobStore.read(artifact.blobKey)) }
      : null,
  }
}
