# 旧宿主接入差异

<!-- cspell:words qygent -->

本文核对 qygent 的实际宿主调用链与 elmino 当前公开 API，作为后续接入清单。**qygent 尚未接入 elmino**；本轮只迁出通用能力，未修改旧宿主、用户配置或运行数据。

框架保持 [15 个能力包](../README.md#首阶段边界)。插件体系、HTTP 服务、客户端 SDK 与 UI 不属于本轮迁移范围。公开入口以各包 `package.json` 的 `exports` 为准，消费方不从 `src` 或仓库相对路径引入生产实现。

## 旧宿主的真实调用链

以下源码路径均相对于 **qygent 仓库根目录**，用于定位来源，不依赖两个仓库在本机的相邻布局。

| 环节 | qygent 源路径 | 当前职责 |
| --- | --- | --- |
| 产品 Agent | `projects/harness/packages/agent/src/preset/code.ts` | `codeAgent` 组合基础 Prompt、`definePlugins()`、`defineLoop()` 与 `defineRuntime()` |
| Server 装配 | `projects/harness/projects/server/src/app/define.ts` | 创建 `AgentResources`、角色解析器和 `AgentEngine`，注入模型恢复、Runtime 工厂、工作区访问凭证与事件发布 |
| 资源所有权 | `projects/harness/projects/server/src/infra/agent/index.ts` | 持有模型配置与认证服务、每个 Agent 的环境、Workspace 控制库、事件 Hub，以及按 Workspace 共享的 RuntimeStore |
| 新建与恢复 Turn | `projects/harness/projects/server/src/modules/thread/runner/service.ts` | 新建时按 `modelId` 解析模型；恢复时读取原 Turn 的 `modelConfig`，再创建可调用模型 |
| 输入与执行 | `projects/harness/projects/server/src/modules/thread/runner/invocation.ts` | 校验工作区、准备图片与文档、解析 `ThreadLocation`，调用 `engine.run/resume(request, store)`，等待 `accepted` 后返回线程快照 |
| 启动与关闭 | `projects/harness/projects/server/src/app/lifecycle.ts` | 初始化插件与工作区，恢复删除意图和各 Workspace 的运行事实；关闭时先等待 Engine，再关闭插件和 Store |

这条链中，HTTP 请求体、模型目录、凭据、Workspace 管理和 SSE 都由宿主持有。elmino 接管执行层，不替宿主创建这些产品服务。

## 模型与 LLM 协议

旧模型服务位于 `projects/harness/projects/server/src/modules/model/service.ts`。它在 `_createAdapter()` 中调用旧 `@qygent/llm` 的统一工厂，工厂源码为 `projects/harness/packages/llm/src/provider/index.ts`。

| 旧入口 | elmino 入口或宿主改动 |
| --- | --- |
| `@qygent/llm` 的 `Request/Message/Part/Event/Usage/Provider` | 改从 `@elmino/llm` 获取统一协议；工具调用参数仍为 `args` |
| `createModelProvider({ model, providerName, credential, apiKeyRequired })` | 宿主按 `model.apiFormat` 选择下列独立适配器，配置对象不再嵌套 `model` |
| `anthropic-messages` | `@elmino/llm-anthropic` 的 `AnthropicMessagesProvider.create()` |
| `chat-completions` | `@elmino/llm-openai/chat-completions` 的 `ChatCompletionsProvider.create()` |
| `responses` | `@elmino/llm-openai/responses` 的 `ResponsesProvider.create()` |
| `ModelProviderApiFormat` | API 格式联合类型由 `ModelTurnConfig['apiFormat']` 表达，不再依赖产品模型目录 |
| `validateModelProviderConfig()` | 没有同名统一出口；宿主保留设置输入校验，并通过目标适配器创建入口核对其配置约束，不把“配置可创建”当作“连接成功” |
| `providerRequiresCredential()` | 没有同名产品辅助入口；宿主按 `apiKeyRequired !== false` 决定是否读取凭据，适配器按显式配置解析认证 |

适配器接受 `model` 原生名称、`baseURL`、`providerName`、`credential`、`apiKeyRequired`、`cache`、`jsonSchema` 等字段，类型为 `@elmino/llm/provider` 的 `ProviderOptions`。例如旧 `model.name` 对应新适配器的 `model`，不是模型配置实例 ID。

旧 `ProviderAuthRouter` 的协议与厂商认证差异已归适配器：例如 Anthropic Messages 下 `mimo` 默认使用 bearer，普通 Messages 默认使用 API Key。宿主应继续传真实 `providerName`；需要覆盖认证时使用 `ProviderOptions.auth`，免认证设置 `apiKeyRequired: false`。无需把旧路由器复制进宿主。

`TurnModel<ModelTurnConfig>` 仍由 `{ config, adapter }` 组成。`config.id/providerId` 是宿主稳定配置 ID，`config.name` 是 Provider 原生模型名称；`config` 只能保存可持久化的非敏感配置，凭据与 SDK 实例不进入运行快照。模型目录、配置升级、启停状态、目录同步与认证文件继续由旧宿主管理。

新 Turn 由宿主解析当前模型；审批恢复由宿主读取原 Turn 的冻结配置再调用 `resume()`。Engine 的 `restoreModel(config)` 主要用于 queued 子线程重启恢复：宿主校验持久化配置、根据冻结 `providerId` 读取当前凭据并返回新的可调用实例，不能静默换成当前默认模型。

这部分可以先独立替换：旧 Agent/Loop 暂时保留，先在旧模型服务边界使用 elmino 适配器，并检查实际消息协议与请求映射。不必同时切换数据库、事件和插件。

## Agent、Engine 与扩展装配

| 旧结构 | elmino 公开 API 与差异 |
| --- | --- |
| `Agent/defineAgent/AgentEngine` 同属 `@qygent/agent` | `Agent/defineAgent` 归 `@elmino/agent`，`AgentEngine` 归 `@elmino/engine` |
| `Agent.plugins: PluginSet` | `Agent.tools: DefinedTools`、可选 `Agent.hooks: AgentHooks`，没有 `plugins` 或 `PluginSet` 兼容入口 |
| 插件集合提供线程投影 | `Agent.thread: Thread`；`defineAgent()` 默认提供 `defineThread()` |
| 显式传 `defineLoop()` | 可继续传 `loop`；省略时 `defineAgent()` 提供默认完整 Loop |
| 产品 `codeAgent` 与工具预设 | 宿主自行定义身份、基础 Prompt、工具与策略；框架不提供产品预设 |
| `LocalSubagentRoles` 与 Engine 同包 | 从 `@elmino/engine` 引入，仍显式传 `{ dir }`；省略角色解析器时 Engine 使用内置 default、explorer、worker |

Engine 的主入口形式保留：

```ts
import { AgentEngine } from '@elmino/engine'

const engine = AgentEngine.create(agents, {
  createRuntime,
  restoreModel,
  resolveSubagentRoles,
  acquireWorkspace,
  onRuntimeEvent,
})

const execution = engine.run(request, store)
await execution.accepted
await execution.completed
```

上面的变量由宿主装配，完整运行示例见 [01-basic-agent](../examples/01-basic-agent)。`accepted` 表示输入和启动事实已经持久化，`completed` 表示本次执行与结算结束；HTTP 宿主可在接纳后返回，继续通过事件观察执行。`resume(request, store)` 恢复原 interrupted Turn，`submit(request, store)` 提交已经持久化的后台任务。

`AgentEngineOptions` 的实际名称仍为 **`onRuntimeEvent`**，不是此前讨论草案中的 `onEvent`。全局回调签名是 `(agentId, event)`；请求也可提供 `(event)` 回调。宿主应按实际入口接线，避免同一个事件被两路重复发布。框架不会创建 SSE Hub、重放缓冲或 HTTP 路由。

### 插件是整体接入前的主要适配点

旧插件契约在 `projects/harness/packages/plugin/src/types/index.ts` 和 `src/preset/index.ts`。旧 `setup/setupTurn` 会注册工具、Prompt、状态、生命周期与交互，并持有 Server Host 的长期服务。elmino 没有迁入注册器、清单、插件依赖解析、插件 HTTP/WebSocket、资源安装或插件 UI。

宿主需要把实际执行能力显式装配为 `tools` 与 Hooks，再切换整个 Engine。不能把旧 `PluginSet` 强制断言为新 `AgentHooks`。

| 旧插件能力 | 可使用的新执行扩展 | 仍由宿主负责 |
| --- | --- | --- |
| `tools.register/restrict` | `defineTool/defineTools/mergeTools`、工具 scope 与 `authorizeTool` | 工具发现、选择、稳定作用域与产品权限规则 |
| `prompt.context/messages/process` | `promptStable/promptDynamic/promptMessages/processMessages` | 组合顺序；消息转换保留 Canonical `id/turnId` 和工具结果配对 |
| `tool.before/after/interrupt/project` | `beforeTool/afterTool/interceptTool/projectTool` | 业务拦截逻辑及自定义展示数据 |
| `lifecycle.on`、Turn 资源释放 | `onLifecycle/onStarted/beforeSnapshot` | 长期服务初始化与关闭；`onStarted` 返回的清理函数只归当前 Turn |
| `snapshot.contribute/update` | `collectState`、执行作用域 `updateState()` | 命名空间归属、状态内容与更新策略 |
| `interactions.resolve/settleState` | `AgentHooks.resolveInteraction/settleState` | 自定义响应校验、状态纯转换；事务回调内不执行外部副作用 |

普通工具审批与恢复流程已在 Loop/Engine 内，不需要宿主重新写一个审批执行器。宿主仍需提供允许的工具、`approvalMode`、授权策略和用户响应入口。自定义 Interaction 使用稳定 `ownerId` 选择宿主处理逻辑，恢复请求必须命中持久化的 Turn 与 interrupt，不能根据 UI 缓存自行认定审批仍有效。

子智能体调度、角色冻结、取消和重启恢复属于 Engine；旧 `projects/harness/plugins/subagent` 的四个模型工具、Prompt 与 UI 不在框架中自动注册。需要这些工具时，宿主通过 `@elmino/tool` 的 `subagentHostService` 获取 Engine 注入的 `SubagentController` 来装配，不能再创建另一套 Child 执行器。

## Runtime、Store、路径与环境

旧实现 `projects/harness/packages/runtime/src/local.ts` 既创建 Sandbox，又通过 `.store()` 打开数据库，还通过 `.plugin(id)` 返回插件隔离目录。新边界分别是：

| 职责 | elmino API | 宿主接入改动 |
| --- | --- | --- |
| 线程位置与执行资源 | `@elmino/runtime` 的 `Runtime/ThreadLocation` | `Runtime` 只提供 `location/sandbox()/dispose()`，没有 `.store()` 或 `.plugin()` |
| 本地 Runtime 组合 | `@elmino/runtime/local` 的 `LocalRuntime.create({ location, sandbox })` 或 `defineRuntime(createSandbox)` | 宿主显式创建 Sandbox；Runtime 接管该执行资源的释放 |
| 本机执行实现 | `@elmino/sandbox-local` 的 `LocalSandbox` | 显式注入 `cwd/env/shell/allowedRoots` 等实际配置；基础 Sandbox 契约归 `@elmino/sandbox` |
| 运行事实存储 | `@elmino/store` 的 `RuntimeStore/RuntimeStoreTx` | Store 按稳定 Workspace 作用域共享，显式传给 Engine |
| SQLite | `@elmino/store-sqlite` 的 `SqliteStore.create({ dataDir, blobStore })` | 数据库目录由宿主确定，不通过创建线程 Runtime 来间接打开 |
| 大正文和二进制 | `@elmino/store/local` 的 `LocalBlobStore.create({ files, rootDir })`，或自定义 `BlobStore` | 文件能力满足 `BlobFiles`；内容存储可以与数据库实现分别替换 |
| 环境与 Shell | `@elmino/local` 的 `LocalEnv/loadUserEnv/resolveLocalShell` | 通用能力可单独替换，产品目录、Shell 偏好设置和应用层变量来源留在宿主 |

旧 `AgentResources.getRuntimeStore()` 通过临时 Runtime 的 `.store()` 取得存储，接入时应改为宿主直接组合 SQLite 与 BlobStore。同一数据库目录共享调用方必须使用同一个 BlobStore 实例，创建方拥有关闭权；Engine 关闭线程 Runtime，不替宿主关闭传入的共享 Store。

关闭顺序应先停止新请求并等待 `engine.close()`，再释放宿主扩展长期资源，最后关闭共享 Store。失败也要等待其他已启动的关闭操作结束并报告原因，不能因一个资源失败而跳过其余清理。

`ThreadLocation` 保留 `workspaceId/workspaceKind/workspaceRoot/dir/cwd`。旧 Server 的 `modules/thread/dir` 与 Workspace 管理仍决定实际位置；框架不会选择用户根目录或自动创建产品任务目录。接入时保持 Thread 所属 Agent、稳定 Workspace 和 `dir`，不能让一次请求重定向已有 Thread。

`@elmino/local` 不提供旧 `resolvePaths/resolveWorkspaceStatePaths/QygentPaths`。宿主继续计算模型配置、认证、control.db、运行数据库、blob 和插件目录，再向框架传入具体能力。通用环境组合顺序为 Shell 基础环境、当前应用层、固定启动覆盖；`refresh()` 并发共享一次加载。已创建 Sandbox/Runtime 使用冻结快照，环境刷新只影响后续装配，不回写已有执行环境。

`LocalSandbox` 的文件写入允许根目录与工具授权都是实际边界，不能把名称理解为操作系统隔离容器。旧项目读取能力本身也不等同于写入根目录限制；若宿主要收紧读取范围，应统一提供符合要求的 Sandbox，而非假定包名变化已经增加隔离。

## Thread 与事件协议差异

运行事件的 ID、归属字段和主要事件名保留，但 **elmino 的领域事件不是旧 SDK 传输协议的直接替代品**。旧传输解析代码位于 `projects/harness/packages/protocol/src/runtime/events.ts` 与 `payload.ts`。

| 数据 | qygent 当前结构 | elmino 当前结构 |
| --- | --- | --- |
| 领域所有者 | `@qygent/protocol` 聚合模型、线程与传输数据 | 消息与设置归 `@elmino/store`，位置归 `@elmino/runtime`，线程状态和 RuntimeEvent 归 `@elmino/thread`，模型协议归 `@elmino/llm` |
| 线程内部快照 | `pluginState/pluginStatePatch` | `extensionState/extensionStatePatch` |
| 公开线程状态 | `ThreadState.plugins` | `ThreadState.extensions` |
| 默认标题 | 展示投影提供缺省文案，旧解析要求字符串 | `ThreadState.title` 和列表标题可缺省，宿主展示时补文案 |
| 自定义 Interaction 归属 | `pluginId` | `ownerId`；Loop 内置审批不需要该字段 |
| 文档类型 | 产品扩展名枚举与解析清单 | 保存扩展名字符串；支持格式、图片预处理与文档解析留在宿主 |
| 流控制与校验 | `stream.connected/reset`、序列化、完整 payload 校验 | 不提供 SSE 控制消息与旧传输解析器，宿主维护自己的边界校验与连接生命周期 |

旧 `payload.ts` 会检查 `ThreadState.plugins`、必填字符串 `title` 及产品文档白名单，直接把新事件交给它会被拒绝，或得到错误投影。需要在宿主传输边界明确采用新契约；若必须继续服务旧客户端，转换只放旧 API 边界，不在 Engine 内同时维护两套状态。

持久化 `ThreadPluginPart`、Mention 的 `pluginId` 和 `ThreadSettings.pluginSettings` 仍作为已有数据契约保留。它们不表示框架已经提供插件注册、资源管理或 UI。接入时按实际字段区分，不能把所有包含 `plugin` 的历史数据机械重命名成扩展字段。

模型 `Event` 是采样过程的即时投影，运行 `RuntimeEvent` 用于 Thread/Turn/消息事实变化；宿主不能把原生 SDK chunk 直接广播成运行事实。断线重连应从持久化 Thread/消息事实校准，SSE Hub 的缓冲、连接代次和客户端缓存继续由宿主维护。

## 数据保留与接入顺序

`@elmino/store-sqlite` 只迁入 Runtime 数据库的版本化迁移，**没有迁入 `SqliteWorkspaceStore` 或 control.db 的 Workspace 表与删除意图**。旧控制库仍位于宿主的 `~/.qygent/agents/<agentId>/control.db`，它和认证、模型配置、Memory、Skill、Task 等长期资产必须保留。

运行迁移资源随包交付，不代表既有运行快照可无条件直接打开：内部扩展状态与交互归属已有变更，接入前应使用专用测试副本验证原库、blob 引用及待决恢复。长期资产变化必须通过明确迁移保存；不能以接入框架为由自动清库、清认证文件、重建控制库或扫描删除插件数据。数据库事务也不会回滚已成功写出的外部 blob。

建议分为以下可独立验收批次，接入完成一批后再删除旧宿主中对应的重复实现：

1. **P0：先替换模型与通用环境能力。** 保留旧 Server/Agent/插件，调整模型服务的适配器工厂与 LLM 类型引用；单独切换 `LocalEnv`、程序探测和 Shell 选择。验证三种模型格式、免认证、推理/工具参数、缓存和环境分层，不读取真实用户配置做默认测试。
2. **P1：完成宿主执行装配。** 将选定 Agent 的实际工具与插件执行贡献映射为 `tools/AgentHooks`，显式组合 Runtime 与共享 Store；保留 Workspace 控制、删除协调、路径和长期服务。先以专用数据目录验证，不同时让两套 Engine 写同一运行库。
3. **P2：切换 Thread 与传输边界。** 同步线程快照、事件 payload、标题兜底、交互 `ownerId` 与新扩展字段，验证旧客户端需要的边界转换，再切换新建、恢复和控制入口。图片压缩、文档解析与上传校验仍在 Server。
4. **P3：验收完整生命周期后清理重复实现。** 覆盖接纳失败、正常结束、工具失败、审批暂停与跨进程恢复、取消/引导、排队 Child 恢复、删除协调和关闭清理，再移除旧 Agent/Loop/Thread/Store/Runtime 中已被框架替代的实现。插件宿主、SDK、UI 和长期资产仍归产品，不因执行内核替换而删除。

[01-basic-agent 示例](../examples/01-basic-agent) 用于验证公开包的显式装配与真实工具执行，不能替代旧宿主的审批恢复、插件、HTTP/SSE、附件和用户资产接入验收。工程检查与 tarball 验收方式见 [开发指南](contributing.md)。
