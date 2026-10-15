<p align="center">
  <img src="docs/assets/elmino-logo.png" alt="elmino logo" width="300">
</p>

<h1 align="center">elmino</h1>

<p align="center"><strong>可组合、可持久化的 TypeScript Agent 开发框架</strong></p>

<p align="center">
  <a href="https://github.com/elmino-ai/elmino/actions/workflows/ci.yml"><img src="https://github.com/elmino-ai/elmino/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node.js-24-339933" alt="Node.js 24">
  <img src="https://img.shields.io/badge/pnpm-11-F69220" alt="pnpm 11">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#如何使用">如何使用</a> ·
  <a href="#包与扩展">包与扩展</a> ·
  <a href="#todo">TODO</a> ·
  <a href="docs/contributing.md">开发指南</a>
</p>

elmino 把模型调用、工具执行、会话状态和执行调度组合成可复用的 Agent 运行时。你可以把它嵌入自己的 Node.js 应用，构建需要调用工具、操作文件、等待人工审批或调度子智能体的助手

模型、持久化和执行环境通过接口装配。你可以只用模型适配器，也可以组合完整的 Agent；应用自己决定数据放在哪里、工具允许做什么，以及如何向用户展示执行过程

> **开发预览**：当前包版本为 `0.0.0`，尚未发布到 npm，请先通过仓库内示例体验。Agent 运行时、远程 Server 和纯客户端 SDK 已具备基础，API 仍会调整；插件体系与 UI 留待后续

## 为什么使用 elmino

- **模型按需接入**：统一消息、工具调用和流式事件，支持 OpenAI Responses、Chat Completions、Anthropic Messages，以及对应协议的兼容服务
- **执行状态可保存**：持久化 Thread、Turn、Step 和工具调用，支持工具审批、中断恢复与工作区执行恢复
- **工具直接定义**：用 Zod 描述参数，配置工具作用域、审批和并行策略，执行函数通过上下文取得所需资源
- **能力可以替换**：分别提供模型适配、RuntimeStore、BlobStore 和 Sandbox 接口，内置 SQLite 与本地文件实现
- **过程可以观察**：通过运行事件订阅模型返回的可见思考、正文、工具输出和执行状态
- **子智能体可以调度**：提供角色、任务排队、父子线程关联及取消与恢复能力，由应用装配具体工具入口

## 快速开始

使用 **Node.js 24.18.1** 和 **pnpm 11.18.0**，版本与仓库配置保持一致

### 1. 获取项目

```sh
git clone https://github.com/elmino-ai/elmino.git
cd elmino
pnpm install --frozen-lockfile
```

### 2. 配置模型

第一个示例使用真实 DeepSeek 模型，通过 Anthropic Messages 协议调用

```sh
cp examples/tutorial/01-basic-agent/.env.example examples/tutorial/01-basic-agent/.env
```

打开刚创建的 `examples/tutorial/01-basic-agent/.env`，填写自己的密钥：

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
```

每个 example 使用自身目录下的 `.env`，由启动命令自动加载；真实文件已被 Git 忽略，仓库只保存不含密钥的 [.env.example](examples/tutorial/01-basic-agent/.env.example)

### 3. 运行 Agent

```sh
pnpm example:basic-agent
```

命令会先构建所需的框架包，再启动示例。Agent 接收写文件任务，调用 `write_note`，将 `Hello from elmino` 写入新建临时工作区的 `result.txt`

简单版只传必填参数，执行结束后打印回复和数据目录：

```text
回复： …模型的完成说明…
示例数据目录： …/elmino-basic-agent-…
```

示例使用 SQLite 与本地文件内容存储保存运行数据，调用结束后自动释放。临时工作区会保留，可在其中查看 `workspace/result.txt`

需要查看完整配置、实时思考与回复、超时和结果检查时，运行 [02-full-agent](examples/tutorial/02-full-agent)。先在它自己的 `.env` 中填写模型密钥：

```sh
cp examples/tutorial/02-full-agent/.env.example examples/tutorial/02-full-agent/.env
pnpm example:full-agent
```

完整版会实时打印可见思考与回复，并展示最终状态、线程 ID、Turn ID 和文件内容。两种用法的对照见 [Basic Agent 示例指南](docs/basic-agent.md)

需要通过 HTTP 调用 Agent 时，使用第三个 [Server / SDK 示例](docs/server-sdk-example.md)：在 `examples/tutorial/03-server-sdk/.env` 中填写模型凭据与 `SERVER_KEY`，然后在两个终端分别运行：

```sh
# 终端一：启动常驻 Server，默认 http://127.0.0.1:3000
pnpm example:server-sdk
```

```sh
# 终端二：通过 SDK 提交任务并打印思考、工具结果与回复
pnpm example:server-sdk:client
```

客户端完成后退出，Server 继续运行；在 Server 终端按 `Ctrl+C` 关闭服务。运行数据默认保存在示例目录下的 `.elmino`，重启时复用

Server 启动后，可打开 [http://127.0.0.1:3000/api/docs](http://127.0.0.1:3000/api/docs) 浏览和调试 API；在 Scalar 的 Bearer 认证中填写示例的 `SERVER_KEY`。OpenAPI 定义位于 `/api/spec.json`，SDK 仍使用 `/rpc`

## 如何使用

示例按用途组织，Tutorial 按顺序学习，Reference 按能力查阅；第三方接入示例后续归 `integration`

| 分类 | 示例 | 内容 | 启动命令 |
| --- | --- | --- | --- |
| Tutorial | [01-basic-agent](examples/tutorial/01-basic-agent) | 最少参数，完成一次任务 | `pnpm example:basic-agent` |
| Tutorial | [02-full-agent](examples/tutorial/02-full-agent) | 单次运行的可选配置、实时输出与结果处理 | `pnpm example:full-agent` |
| Tutorial | [03-server-sdk](examples/tutorial/03-server-sdk) | 常驻服务与远程客户端 | `pnpm example:server-sdk` |
| Reference | [agent-engine](examples/reference/agent-engine) | 多轮、审批恢复与引擎资源管理 | `pnpm example:agent-engine` |
| Reference | [agent-hooks](examples/reference/agent-hooks) | 上下文、工具策略与 Turn 清理 | `pnpm example:agent-hooks` |
| Reference | [turn-control](examples/reference/turn-control) | 运行中引导与中断 | `pnpm example:turn-control` |
| Reference | [subagents](examples/reference/subagents) | 显式派生与等待子任务 | `pnpm example:subagents` |

### 从可运行示例开始修改

[01-basic-agent](examples/tutorial/01-basic-agent) 是一个独立的私有 workspace，通过 `@elmino/*` 公开入口使用框架。入口只有 [src/index.ts](examples/tutorial/01-basic-agent/src/index.ts)，其他职责按目录组织：

| 想改什么 | 从哪里开始 |
| --- | --- |
| 系统提示词、工具与运行环境定义 | [agent/agent.ts](examples/tutorial/01-basic-agent/src/agent/agent.ts) |
| 单次任务、临时目录与结果展示 | [app/run.ts](examples/tutorial/01-basic-agent/src/app/run.ts) |
| 工具名称、参数与执行逻辑 | [tool/write-note.ts](examples/tutorial/01-basic-agent/src/tool/write-note.ts) |
| 模型配置与适配器 | [model/deepseek.ts](examples/tutorial/01-basic-agent/src/model/deepseek.ts) |
| 文件与 Shell 执行环境 | [runtime/runtime.ts](examples/tutorial/01-basic-agent/src/runtime/runtime.ts) |
| 运行数据目录与存储配置 | [app/run.ts](examples/tutorial/01-basic-agent/src/app/run.ts) |
| 完整配置、超时与结果处理 | [app/run.ts](examples/tutorial/02-full-agent/src/app/run.ts) |
| 思考与正文的终端输出 | [terminal/terminal.ts](examples/tutorial/02-full-agent/src/terminal/terminal.ts) |

### Agent 的调用方式

完整配置边界、工具 Schema、Hooks、运行环境和存储所有权见 [Agent 使用指南](docs/agent.md)

`defineAgent()` 只描述 Agent 的行为，最基础的定义只需提示词、工具和运行环境：

```ts
import { defineAgent } from '@elmino/agent'

const writer = defineAgent({
  id: 'writer',
  systemPrompt: '按用户要求调用工具完成写入',
  tools,
  runtime,
})
```

单次任务使用 `runAgent()`，模型、Store 和工作区由应用选择：

```ts
import { runAgent } from '@elmino/engine'
import { sqliteStore } from '@elmino/store-sqlite'

const result = await runAgent({
  agent: writer,
  model,
  store: sqliteStore({ dataDir: './.elmino' }),
  workspace: { id: 'example', rootDir: './workspace' },
  input: '请写入 Hello from elmino',
  onRuntimeEvent: event => console.log(event.type),
})
console.log(result.status, result.message)
```

`tools`、`runtime` 与 `model` 来自上表中的示例模块；调用前创建项目目录。`sqliteStore()` 只定义配置，首次运行才打开 SQLite，并自动配置本地文件内容存储。工作区 ID 对应宿主持有的存储作用域；入口自动生成 Thread 和 Turn ID，将字符串转为文本输入，等待执行结算并释放 Engine。返回值包含 `threadId`、`turnId`、`workspaceId`、持久化 `status`、可选的助手 `message` 与失败原因 `errorMessage`。配置方式由入口在 Engine 结束后释放存储；也可以传入自行创建的 `RuntimeStore` 实例，其关闭仍由应用负责

每次 `runAgent()` 都创建独立线程。审批等待会返回 `interrupted`，Loop 已结算的执行失败返回 `failed` 和原因；入口异常、取消和关闭错误继续抛出。需要多轮会话、接纳后立即返回、后台调度或审批恢复时，使用 `AgentEngine`，见 [高级用法参考](docs/agent-engine.md)

### 高级参考：AgentEngine

[agent-engine](examples/reference/agent-engine) 直接管理 Engine 和 Store，演示同线程两轮对话、工具审批暂停、关闭并重建 Engine、读取持久化中断后恢复原 Turn。先在该示例自己的 `.env` 中填写模型凭据：

```sh
cp examples/reference/agent-engine/.env.example examples/reference/agent-engine/.env
pnpm example:agent-engine
```

终端展示待审工具后，输入 `y` 才执行写入。源码导航、资源所有权和同进程引擎重建的边界见 [高级用法指南](docs/agent-engine.md)

### 只使用模型适配器

模型适配器可以独立于 Agent 使用。OpenAI 的两种格式分别从 `@elmino/llm-openai/responses` 和 `@elmino/llm-openai/chat-completions` 引入，Anthropic Messages 从 `@elmino/llm-anthropic` 引入，公共消息与请求类型归 `@elmino/llm`

各包都能独立构建与打包。当前请在 workspace 中消费，或按 [开发指南](docs/contributing.md#独立-npm-包交付) 生成 tarball 后安装到自己的项目，正式 npm 安装入口会随首个版本发布补齐

## 包与扩展

20 个能力包按职责拆分，各自声明依赖和公开入口，不要求应用把所有包都直接引入。使用 Agent 的应用通常直接组合 `agent`、`engine`、模型适配器，以及所需的存储和执行环境

| 包 | 职责 |
| --- | --- |
| [`@elmino/agent`](packages/agent) | Agent 定义，装配工具、Hooks、Loop、Thread 和 Runtime |
| [`@elmino/engine`](packages/engine) | 执行调度、生命周期、中断恢复与子智能体协调 |
| [`@elmino/loop`](packages/loop) | 单轮模型采样、工具执行、上下文管理与审批 |
| [`@elmino/thread`](packages/thread) | 会话快照、历史、线程状态投影与运行事件 |
| [`@elmino/tool`](packages/tool) | 工具定义、参数、授权、审批与执行契约 |
| [`@elmino/llm`](packages/llm) | 模型公共消息、请求、结果和流事件 |
| [`@elmino/llm-openai`](packages/llm-openai) | OpenAI Responses 与 Chat Completions 适配器 |
| [`@elmino/llm-anthropic`](packages/llm-anthropic) | Anthropic Messages 适配器 |
| [`@elmino/store`](packages/store) | RuntimeStore、BlobStore 与运行数据契约 |
| [`@elmino/store-sqlite`](packages/store-sqlite) | SQLite 持久化与版本化迁移 |
| [`@elmino/runtime`](packages/runtime) | 线程位置与运行资源生命周期 |
| [`@elmino/sandbox`](packages/sandbox) | 文件、Shell 和执行权限的接口 |
| [`@elmino/sandbox-local`](packages/sandbox-local) | 本地文件、Shell、PTY 和进程执行 |
| [`@elmino/local`](packages/local) | 本机环境、Shell 选择与程序探测 |
| [`@elmino/shared`](packages/shared) | 跨包复用的通用工具与类型 |
| [`@elmino/request`](packages/request) | 动态 Header、HTTP 错误与 `/orpc` 请求入口 |
| [`@elmino/protocol`](packages/protocol) | 跨端事件、线程快照校验、序列化与恢复游标 |
| [`@elmino/api`](packages/api) | Agent、Thread、Turn 与事件流的类型化接口契约 |
| [`@elmino/server`](packages/server) | 可直接 start 的 Agent 服务，也可嵌入 Fetch 宿主，提供 REST 与 Scalar 文档 |
| [`@elmino/sdk`](packages/sdk) | Node.js / 浏览器客户端，支持订阅、重连与取消 |

请求与协议的调用方式、旧包取舍及下一批边界见 [请求与事件协议](docs/transport.md)

远程调用、宿主注入与生命周期见 [Server 与 SDK 指南](docs/server-sdk.md)

需要替换能力时，可以从这些边界接入：

| 扩展目标 | 接口或入口 |
| --- | --- |
| 更换模型协议实现 | `@elmino/llm` 的 `Provider` |
| 更换数据库 | `@elmino/store` 的 `RuntimeStore` |
| 更换大正文与二进制存储 | `@elmino/store` 的 `BlobStore`，本地实现从 `@elmino/store/local` 引入 |
| 更换文件与命令执行环境 | `@elmino/sandbox` 的 `Sandbox`，通过 Runtime 装配 |
| 自定义上下文、工具策略和执行行为 | `@elmino/agent` 的 `AgentHooks` 与 `@elmino/tool` 的工具定义 |
| 对接界面或传输层 | `onRuntimeEvent`，由应用决定如何展示或传输 |

`LocalSandbox` 在本机执行，不能作为容器隔离使用。更强的隔离需要提供相应 Sandbox 实现；数据库事务也不会撤销工具已经完成的文件写入等外部操作

## TODO

以下清单区分已实现能力与后续工作，顺序表示当前推进方向，不承诺发布时间

### 已完成

- [x] 统一模型协议，接入 OpenAI 与 Anthropic 格式适配器
- [x] Agent、Loop、Thread、工具执行与 Engine 生命周期
- [x] 工具审批、中断恢复与子智能体调度
- [x] RuntimeStore / BlobStore 接口，SQLite 与本地文件实现
- [x] 模块独立构建、类型声明、Changesets 和仓库外 tarball 验收
- [x] 首个真实模型示例，支持独立环境配置、思考与正文输出
- [x] 通用请求层与跨端事件协议，支持独立入口及浏览器构建验收
- [x] API 契约、可注入 Server 和纯客户端 SDK，支持事件回放与审批恢复
- [x] OpenAPI 定义与 Scalar 交互文档，REST 与 SDK 共用宿主鉴权
- [x] `03-server-sdk` 真实模型示例，以及真实 TCP 断网回放与 Server 重建恢复测试
- [x] Ubuntu / macOS CI，覆盖构建、类型、测试、迁移与公开包的仓库外交付验收

### 近期

- [x] AgentEngine 用法参考：多轮对话、工具审批与同进程引擎重建恢复
- [x] Hooks、自定义工具、运行中引导/中断和显式子任务参考示例
- [ ] 补齐跨进程恢复等单一功能示例
- [x] Agent 使用指南、生命周期与子智能体调用参考
- [ ] 补齐持久化接入与 Sandbox 扩展指南
- [ ] 完成真实应用接入与执行生命周期验收，明确宿主需要承担的职责
- [ ] 梳理首个公开版本的 API、版本策略与变更记录
- [ ] 确定许可证并补齐 `LICENSE` 文件
- [ ] 配置 npm 发布流程，发布首个可独立安装的预览版本

### 后续方向

- [ ] 增加数据库、内容存储与隔离执行环境的适配实现
- [ ] 插件体系与插件开发能力
- [ ] 高度可定制的 UI 与独立界面组件

## 开发与贡献

欢迎通过 [Issues](https://github.com/elmino-ai/elmino/issues) 提交问题、使用反馈和功能建议。涉及公开 API 或执行生命周期的较大调整，建议先讨论目标与边界

从仓库根目录运行：

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm spellcheck
pnpm verify:packages
```

包级测试归所属包的 `tests`，交付验收位于根 `tests`。`verify:packages` 会打包全部公开能力包，在仓库外安装并验证运行、类型与依赖隔离，不会发布 npm 包

- [开发指南](docs/contributing.md)：环境、常用命令、测试、迁移、提交与包交付
- [Agent 使用指南](docs/agent.md)：入口选择、工具、Hooks、模型与存储所有权
- [运行控制](docs/agent-control.md)：引导接纳、Step 边界、中断与取消
- [子智能体](docs/subagents.md)：宿主服务、角色、派生与等待
- [Basic Agent 示例](docs/basic-agent.md)：真实模型配置、源码导航与运行说明
- [请求与事件协议](docs/transport.md)：独立请求入口、跨端 Schema 与后续远程调用边界
- [Server 与 SDK](docs/server-sdk.md)：远程调用、资源注入与重连恢复
- [Server / SDK 示例](docs/server-sdk-example.md)：常驻 Server、独立 SDK 客户端与环境配置
- [AgentEngine 高级参考](docs/agent-engine.md)：线程多轮对话、审批恢复与引擎生命周期
- [已有宿主接入清单](docs/integration.md)：接口差异、资源所有权与数据保留
- [开发约定](AGENTS.md)：能力边界与代码规则
