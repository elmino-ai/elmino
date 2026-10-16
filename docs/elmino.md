# Elmino 应用实例

`@elmino/core` 提供 `defineElmino()`，注册 Agent、模型和工作区，管理共享 Engine 与存储租约。实例可以直接用于本地执行，也可以传给一个或多个 Server。核心不依赖 Hono、oRPC、SDK 或具体数据库实现

## 定义与调用

```ts
import { defineElmino } from '@elmino/core'
import { sqliteStore } from '@elmino/store-sqlite'

const elmino = defineElmino({
  agents: { writer },
  models: {
    deepseek: ({ frozenConfig }) => createModel(frozenConfig),
  },
  defaults: { model: 'deepseek' },
  workspace: {
    id: 'project',
    rootDir: './workspace',
    store: sqliteStore(),
  },
})

const agent = elmino.getAgent('writer')
const result = await elmino.run({ agentId: agent.id, input: '完成当前任务' })
```

`writer` 是 `defineAgent()` 返回的定义，包含提示词、工具、Hooks 与 Runtime。`createModel()` 是宿主的模型工厂，凭据留在适配器中，`config` 只保存可持久化配置。项目目录由宿主准备；定义实例和查询 Agent 元数据不会打开数据库或调用模型

`getAgent()` 返回注册的 Agent 定义；通过 `run()` 执行可以复用当前实例的 Engine 与工作区资源。`sqliteStore()` 自行读取 `ELMINO_DATA_DIR`，缺省使用定义时当前目录下的 `.elmino`，也可传显式 `dataDir` 覆盖；Elmino 不绑定环境库或数据库实现。首次调用才借用存储配置，任务结束后实例继续持有租约，直到 `elmino.close()`。这与每次独立创建、释放 Engine 的 `runAgent()` 不同；现有底层能力包仍可独立使用

`run()` 默认新建线程与 Turn，固定工作区可以省略 `workspaceId`。多轮调用可传已有 `threadId`；每轮使用新的 `turnId`。动态工作区必须显式提供 `workspaceId`。返回值包含线程与执行身份、持久化状态和最终助手消息，失败或中断也可能使执行 Promise 拒绝

## 模型与默认值

模型注册键必须与工厂返回的 `config.id` 一致，例如 `deepseek`。只有一个注册模型时自动使用它；多个模型可以由 Agent 的 `model` 或应用的 `defaults.model` 指定。注册项也可以直接传 `TurnModel` 实例，历史配置可能变化时应使用工厂重新装配适配器

新任务的模型选择顺序为：

1. 本轮提供的 `modelId`
2. 已有线程记录的模型 ID
3. Agent 定义的 `model`
4. 应用的 `defaults.model`
5. 唯一的注册模型

恢复原 Turn 按冻结配置中的模型 ID 找工厂，并要求返回的配置与快照一致；不读取当前默认模型。`defaults.approvalMode` 和 `defaults.subagentMode` 用于新 Turn，本轮可以覆盖；恢复不覆盖原执行权限

动态模型目录可以直接使用函数，不要求预先列出所有配置：

```ts
const elmino = defineElmino({
  agents,
  workspace,
  models: ({ agentId, workspaceId, modelId, frozenConfig, signal }) =>
    loadModel({ agentId, workspaceId, modelId, frozenConfig, signal }),
})
```

`loadModel` 由宿主实现，负责凭据、目录权限和原快照恢复。工作区也可使用 `workspace({ agentId, workspaceId, signal })` 动态提供 `store` 和 `location({ threadId, dir })`，固定目录的越界检查和持久化目录恢复由核心统一处理

## 分开创建 Server

```ts
import { defineServer } from '@elmino/server'

const server = defineServer({
  elmino,
  apiKey: accessToken,
  corsOrigins: ['http://localhost:5173'],
})

const url = await server.start()
```

Server 默认使用 Hono。模型、工作区、存储与 Engine 配置只在 Elmino 中声明一次；鉴权、CORS、文档、HTTP 扩展与端口归 Server。通过 `server.elmino` 可访问当前接入借用的同一实例，Server 不会创建第二套 Engine。详细 HTTP 用法见 [Server 与 SDK](server-sdk.md)，可运行装配见 [Server 教程](server-example.md)，远程客户端另见 [SDK 教程](sdk-example.md)

`elmino.subscribe({ onEvent, onClose })` 供本地观察器或接入方监听同一份运行事实，返回取消函数。取消观察或关闭某个 Server 不会取消任务。每个 Server 管理自己的事件回放窗口，重建 Server 后 SDK 通过 reset 重新读取持久状态

## 关闭与所有权

```ts
await server.close()
await elmino.close()
```

Server 关闭自己的请求、订阅和监听；Elmino 关闭共享执行，结束观察，再释放存储配置租约。直接传入的 Store 实例及动态工作区返回的 Store 仍由创建方关闭。多个 Server 共享实例时，可以单独关闭其中一个，其他接入与本地执行继续工作

关闭整个应用时，由创建方协调两者。存在尚未结束的执行入口时，可以并行发起关闭，让 Engine 取消解除等待中的请求，再检查两个关闭结果：

```ts
const results = await Promise.allSettled([server.close(), elmino.close()])
throwSettledErrors(results, '关闭应用失败', true)
```

`throwSettledErrors` 从 `@elmino/shared` 导入。CLI 宿主可使用 `server.start({ shutdownSignals: false })`，自行在退出信号中执行上述流程。Server 默认的信号处理只关闭自己，不会擅自回收传入的共享实例

Elmino 关闭开始后拒绝新的操作，并通过 `signal` 通知尚未完成的资源解析。宿主异步工厂应响应取消或自行结束等待。关闭已完成的实例不能重新运行，需要重新 `defineElmino()`；使用相同数据目录可以读取历史并恢复原中断
