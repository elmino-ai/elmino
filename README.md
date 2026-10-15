# elmino

elmino 是面向应用开发的可复用 Agent 框架，首阶段聚焦模型适配与 Agent 内核

模型适配、完整 Agent 运行层和本机环境装配已迁入 elmino，15 个能力包可以独立构建和打包。宿主应用接入及重复实现清理另行推进

## 首阶段边界

| 包 | 目录与状态 | 职责 |
| --- | --- | --- |
| `@elmino/shared` | [packages/shared](packages/shared) | 跨包使用的纯工具和基础类型，不依赖模型或运行环境 |
| `@elmino/llm` | [packages/llm](packages/llm) | 统一请求、消息、流事件、工具调用、用量、结构化解析和 Provider 契约 |
| `@elmino/llm-openai` | [packages/llm-openai](packages/llm-openai) | OpenAI SDK 及 Chat Completions、Responses 和兼容服务差异 |
| `@elmino/llm-anthropic` | [packages/llm-anthropic](packages/llm-anthropic) | Anthropic SDK 及 Messages 和兼容服务差异 |
| `@elmino/store` | [packages/store](packages/store) | RuntimeStore、BlobStore、运行记录与持久化线程数据契约；`/local` 提供 LocalBlobStore |
| `@elmino/store-sqlite` | [packages/store-sqlite](packages/store-sqlite) | SqliteStore、数据库仓储、版本化迁移与事务生命周期 |
| `@elmino/sandbox` | [packages/sandbox](packages/sandbox) | 文件、Shell、PTY 与执行权限的纯契约 |
| `@elmino/sandbox-local` | [packages/sandbox-local](packages/sandbox-local) | 本机文件、进程、PTY、命令评审与资源释放 |
| `@elmino/local` | [packages/local](packages/local) | 不可变环境快照、登录环境加载、程序探测、Shell 选择和受控命令执行 |
| `@elmino/runtime` | [packages/runtime](packages/runtime) | 线程执行位置与 Runtime 生命周期；`/local` 通过注入 Sandbox 装配 |
| `@elmino/tool` | [packages/tool](packages/tool) | 工具定义、参数校验、作用域、审批、HostServices 与子智能体控制契约 |
| `@elmino/thread` | [packages/thread](packages/thread) | Canonical 上下文、恢复快照、消息投影、工具事实提交和运行事件 |
| `@elmino/loop` | [packages/loop](packages/loop) | 单轮执行、上下文投影、采样恢复、工具并行、审批与执行 Hooks |
| `@elmino/agent` | [packages/agent](packages/agent) | 装配工具、Hooks、Loop、Thread 和 Runtime，默认提供完整执行器 |
| `@elmino/engine` | [packages/engine](packages/engine) | Agent 调度、Turn 接纳与互斥、Step 记账、中断恢复、子智能体和资源释放；`/job` 提供辅助任务队列 |

模型适配层独立于执行内核。模型适配器包依赖 `llm` 契约和各自 SDK，`llm` 与 `engine` 不依赖具体适配器包。执行内核通过宿主注入模型、存储、运行环境和事件处理能力

产品身份、账号、模型目录管理、内置产品工具、插件体系、HTTP 服务、客户端 SDK 与 UI 由应用或后续阶段承载

只为实际能力创建包目录；本地沙箱实现单独安装，基础契约、Runtime 和工具包不引入 PTY、ripgrep 等本机依赖

`shared` 提供对象、JSON、ID、异步、Prompt 和实际跨包使用的通用类型；Node 路径和模板读取从 `@elmino/shared/node` 引入。任务调度由 `engine/job` 持有，基础工具不会带入队列或本机依赖

## npm 包组织与交付

仓库使用 pnpm monorepo，每个公开能力包拥有自己的 `package.json`、版本、构建脚本和公开入口。根项目负责开发组织，保持 `private: true`；实际发布的是 `@elmino/*` 能力包

独立包隔离安装依赖和发布边界；包内需要细分 API 时，通过明确的 `exports` 子路径提供。消费方按需要安装包，再从包根或已声明的子路径导入

- 产物使用 ESM JavaScript 和 TypeScript 类型声明，公开入口指向 `dist` 中的实际文件
- `tsconfig.base.json` 维护检查规则，`tsconfig.build.base.json` 提供声明配置；公共 `tsdown.config.mjs` 保留包内模块目录并生成 JavaScript、类型与映射，各包声明自身源码范围
- 各包使用 `files` 白名单交付 `dist` 与映射所需的 `src`，不包含测试、开发配置或本地环境文件；公开入口始终指向编译产物
- TypeScript 源码的相对导入省略文件后缀；构建器为 JavaScript 和声明中的相对路径补齐 `.js`，发布包可直接被 Node.js ESM 消费
- workspace 依赖在打包时转换为发布版本范围，产物不依赖仓库别名、源码目录或本地路径
- 模型适配器按 SDK 依赖独立交付，安装 OpenAI 适配器时无需安装 Anthropic SDK
- 数据库存储独立交付，安装 `store` 不安装 Drizzle、dayjs 或模型 SDK；基础入口不引入本地文件实现
- 已接入 Changesets，模型包与共享基础的 minor 变更记录在 `.changeset`；当前开发版本为 `0.0.0`，尚未发布到 npm

`pnpm verify:packages` 为 15 个能力包生成 tarball，检查公开入口、类型声明、映射源码和依赖版本，再分别安装到仓库外临时目录，执行公共工具、类型检查、SDK 请求投影、环境快照与实际 Sandbox 装配、文件与 Shell 执行、数据库事务与关闭重开、默认 Agent 执行、审批恢复、文本和二进制产物持久化及依赖隔离检查。尚未发布的内部依赖由消费项目的 pnpm overrides 指向同批 tarball，打包文件中的正常版本声明保持不变。临时目录保留供失败诊断，不读取用户模型配置，不调用真实模型服务

交付集成测试按能力组织在 `tests/<feature>/consumer.ts`，执行入口位于 [tests/runner/run.mjs](tests/runner/run.mjs)，由 `pnpm verify:packages` 单独执行。tarball 输出到 `dist/packs`，根项目不参与打包。宿主应用接入与重复实现清理作为后续独立批次执行

组织方式参考 [Mastra workspace](https://github.com/mastra-ai/mastra/blob/main/pnpm-workspace.yaml)、[Core 的公开入口与产物清单](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)、[LibSQL 独立包](https://github.com/mastra-ai/mastra/blob/main/stores/libsql/package.json) 和 [Changesets 配置](https://github.com/mastra-ai/mastra/blob/main/.changeset/config.json)。Mastra 同时使用独立包与包内子路径，并对部分紧密关联的包设置同步版本组；elmino 按实际依赖划分发布边界

## 开发环境

- Node.js 24.18.1
- pnpm 11.18.0
- TypeScript 6.0.3
- ESM，运行时使用标准 Node.js 模块解析

在仓库根目录安装依赖：

```sh
pnpm install
```

根脚本提供实际包的构建、检查与交付验证：

```sh
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm verify:packages
```

测试从公开入口消费构建产物；根 Turbo 命令按依赖安排构建，直接运行包级测试前先构建受影响的公开入口。日常只检查修改文件，完整检查用于交付前或用户明确要求的场景

使用 `pnpm changeset` 记录后续变更，`pnpm version:packages` 生成正式版本与变更日志并更新内部依赖，之后执行 `pnpm install` 更新锁文件。发布动作单独授权

## 模型包使用

从 OpenAI 包根导入两类适配器，或只引用需要的公开子路径；安装 Anthropic 包时不依赖 OpenAI SDK

```ts
import { ResponsesProvider } from '@elmino/llm-openai/responses'

const provider = ResponsesProvider.create({
  model: 'your-model',
  credential: process.env.MODEL_API_KEY,
})
const result = await provider.generate({
  system: [{ type: 'text', text: '用中文回答' }],
  messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
  maxOutputTokens: 1024,
})
console.log(result)
```

Chat Completions 使用 `@elmino/llm-openai/chat-completions` 的 `ChatCompletionsProvider`；Anthropic 使用 `@elmino/llm-anthropic` 的 `AnthropicMessagesProvider`，三者共用 `Request`、`Result` 和 `Event` 契约

公共协议按 `message`、`request`、`stream`、`usage`、`object`、`cache`、`provider` 和 `adapter` 提供子路径。`baseURL` 指定兼容服务地址，`providerName` 选择厂商差异；免认证接口设置 `apiKeyRequired: false`，不发送保存的凭据。适配器实例保存自身配置，Responses 续接状态属于该实例，建议按会话或 Turn 创建实例

## 存储使用

从契约包选择本地内容存储，SQLite 实现独立安装；文件能力由宿主提供，满足 `@elmino/store/local` 的 `BlobFiles` 契约

```ts
import type { RuntimeStore } from '@elmino/store'
import { SqliteStore } from '@elmino/store-sqlite'
import { LocalBlobStore } from '@elmino/store/local'

const blobStore = LocalBlobStore.create({
  files: persistenceFiles,
  rootDir: blobsDir,
})
const store: RuntimeStore = await SqliteStore.create({
  dataDir: databaseDir,
  blobStore,
})

try {
  await store.transaction(async (tx) => {
    await tx.threads.upsert({ id: threadId, agentId, dir: '.' })
    await tx.artifacts.write({
      threadId,
      contentKind: 'text',
      contentText: '需要保存的运行内容',
    })
  })
}
finally {
  await store.close()
}
```

`RuntimeStore` 保存 Thread、Turn、Step、工具调用、Canonical 历史、transcript、子线程关系与 artifact 元信息。SQLite 中小文本或 JSON 可以内联，大正文和二进制内容通过注入的 `BlobStore` 保存；更换数据库实现时实现同一契约，更换内容存储时实现 `write`、`read`、`exists` 即可

同一数据库目录共享连接时必须共享同一个 `BlobStore` 实例，由装配方统一关闭；先关闭再更换内容存储实现。数据库事务只回滚数据库记录，已经成功写出的 blob 不随数据库回滚；文件能力实现负责目录创建、实际路径权限和写入原子性。`exists` 只在确认内容缺失时返回 `false`，访问失败应拒绝，避免数据库把临时故障当成永久缺失

线程标题未设置时返回空缺，展示默认文案由宿主提供。文档扩展名和模型配置 ID 作为数据保存，解析支持与凭据管理留在宿主。最终报告、导出文件等成果仍通过工作区文件能力写入，不由 BlobStore 扫描收集

SQLite 原始版本化迁移包含在发布包的 `drizzle/runtime/migrations` 中，仓库外安装后可直接建库和重开；迁移失败拒绝打开并保留原数据，不执行自动清库

## 本机环境装配

`@elmino/local` 组合登录 Shell 环境、应用层和显式启动覆盖，按此顺序生成不可变快照。它只依赖纯契约与共享工具，安装时不带入 PTY、数据库或供应商 SDK

```ts
import { loadUserEnv, LocalEnv, resolveLocalShell } from '@elmino/local'

export async function createLocalExecution() {
  const environment = LocalEnv.create({ shell: await loadUserEnv(), loadShell: loadUserEnv })
  environment.setApplicationLayer({ prependPath: ['/opt/project/bin'] })
  const env = environment.snapshot()
  const shell = resolveLocalShell({ env })
  return { environment, env, shell }
}
```

把 `env`、`shell` 传给 Sandbox；显式工具 Shell 通过 `resolveLocalShell({ env, preference: kind })` 解析。`refresh()` 并发调用共用一次加载，失败保留原快照，完成时使用最新应用层；已有 Runtime 继续使用原快照，新建 Runtime 才读取新快照。启动层提供 PATH 时会完整覆盖应用层追加的 PATH

`loadUserEnv` 在 Windows 复制传入环境，在 POSIX 通过登录交互 Shell 加载，以 NUL 分隔记录保留多行值和空白。普通启动失败、非零退出或超时在完成进程清理后返回去除旧激活状态的启动环境；清理失败会拒绝。`runEnvCommand` 支持取消与超时，不提供标准输入；失败时保留命令错误，清理失败包含原失败与清理原因。用户目录、认证、模型配置、工作区数据库和 blob 的路径均由宿主装配

## Agent 调用

模型和存储由宿主注入，下面的函数使用默认 Loop 执行真实工具。宿主提供 `TurnModel<ModelTurnConfig>` 时，`config` 只包含可持久化的非敏感配置，凭据留在 `adapter` 的装配边界

```ts
import type { ModelTurnConfig, TurnModel } from '@elmino/llm'
import type { RuntimeStore } from '@elmino/store'
import { defineAgent } from '@elmino/agent'
import { AgentEngine } from '@elmino/engine'
import { loadUserEnv, LocalEnv, resolveLocalShell } from '@elmino/local'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'
import { createId } from '@elmino/shared'
import { defineTools } from '@elmino/tool'
import * as z from 'zod'

export async function runAgent(model: TurnModel<ModelTurnConfig>, store: RuntimeStore, cwd: string) {
  const environment = LocalEnv.create({ shell: await loadUserEnv(), loadShell: loadUserEnv })
  const agent = defineAgent({
    id: 'assistant',
    systemPrompt: '使用工具完成用户任务',
    tools: defineTools({
      read_file: {
        description: '读取当前工作目录中的文本文件',
        schema: z.object({ path: z.string() }),
        scope: 'inspect',
        execute: async ({ path }, { sandbox }) => {
          const result = await sandbox.files.read(path)
          if (result.error)
            throw new Error(result.error)
          return result.content ?? ''
        },
      },
    }),
    runtime: defineRuntime(({ location }) => {
      const env = environment.snapshot()
      return LocalSandbox.create({
        cwd: location.cwd,
        env,
        shell: resolveLocalShell({ env }),
        resolveShell: (kind, env) => resolveLocalShell({ env, preference: kind }),
      })
    }),
  })
  const engine = AgentEngine.create({ assistant: agent })
  try {
    const execution = engine.run({
      agentId: agent.id,
      threadId: createId('thread'),
      turnId: createId('turn'),
      model,
      location: {
        workspaceId: 'workspace_project',
        workspaceKind: 'project',
        workspaceRoot: cwd,
        dir: '.',
        cwd,
      },
      approvalMode: 'fullAccess',
      input: [{ type: 'text', text: '读取 README.md 并概括项目用途' }],
    }, store)
    await execution.accepted
    return await execution.completed
  }
  finally {
    await engine.close()
  }
}
```

`accepted` 在启动事务提交后完成，`completed` 等待模型、工具、扩展释放和终态持久化。Engine 拥有线程 Runtime 和任务队列的关闭权；宿主拥有注入 Store 的关闭权，在全部 Engine 关闭后调用 `store.close()`

`run` 创建新 Turn，已有 Turn 不能重复启动。`resume` 使用原 `threadId`、`turnId`、冻结模型配置和 `{ interruptId, response }`，审批响应按 Provider 原始 `callId` 配对；过期响应不会重复执行工具。`interrupt` 与 `steer` 在活跃控制面同步取得接纳权，终态等待和事件通知随后完成

同一 Thread 固定所属 Agent、工作区和相对执行目录；Runtime 的实际位置在当前 Engine 内保持一致。错误归属和错误位置请求在事实写入或资源创建前拒绝。需要改变这些稳定事实时，由宿主单独完成资源释放与存储变更，不能借新 Turn 静默换目录

`recoverWorkspace` 校准当前 Agent 丢失的执行，保留孤立运行的中断事实；宿主注入 `restoreModel` 和线程位置解析后，可以重新提交 queued 子线程。内置 `default`、`explorer`、`worker` 角色来自随包交付的完整 Markdown，`LocalSubagentRoles.create({ dir })` 接收显式用户角色目录，不读取产品数据路径

自定义子智能体工具通过 `context.services.require(subagentHostService)` 使用当前根 Turn 的控制器，再调用 `spawn`、`list`、`wait`、`interrupt`。框架持久化父工具调用、父子线程与子 Turn 的关系，重复派生请求按 `parentToolCallId` 关联；子线程不会继续派生下一层控制器

## 可替换与可扩展边界

| 能力 | 注入边界 |
| --- | --- |
| 模型 | `TurnModel` / `Provider`，具体 SDK 由独立适配器包承载 |
| 运行事实 | `RuntimeStore`，SQLite 是独立实现 |
| 内容存储 | `BlobStore`，本地实现从 `store/local` 引入 |
| 文件与执行环境 | `Sandbox` / `RuntimeDefinition`，本机实现由 `sandbox-local` 单独安装 |
| 工具 | `defineTool` / `defineTools`，输入约束、执行器、作用域、审批和并行声明直接配置 |
| 执行扩展 | `AgentHooks`，系统上下文、消息投影、生命周期、工具授权和交互拦截直接注入 |
| 自定义交互与状态 | `resolveInteraction` / `settleState`，命名空间恢复状态与 Turn 转换在同一事务提交 |
| 单轮执行器与线程投影 | `Loop` / `Thread`，默认使用框架真实实现 |
| 事件、模型恢复与角色目录 | `onRuntimeEvent` / `restoreModel` / `resolveSubagentRoles`，由宿主提供 |

扩展没有注册中心或插件宿主。`onStarted` 返回当前 Turn 的资源释放函数；等待交互时保存扩展状态，恢复或取消时由纯 reducer 与事实转换一同提交。内置审批不属于自定义扩展命名空间，自定义交互使用 `ownerId` 表达稳定归属

## 工程与迁移状态

已迁入提交 Hook、commitlint、统一 catalog 与严格类型检查、CSpell、Turbo 构建缓存、包级测试、SQLite 迁移生成与一致性校验、Changesets 和仓库外 tarball 验收。Ubuntu/macOS CI 是为独立框架新增的验证入口，尚未在远程运行，不执行发布

elmino 的模型、共享基础、持久化、线程、执行环境、工具、Loop、Agent 和 Engine 分批提交并独立验收。插件体系、客户端 SDK、UI 和宿主应用接入留待后续明确任务

开发命令与工程基建见 [开发指南](docs/contributing.md)，约定见 [AGENTS.md](AGENTS.md)
