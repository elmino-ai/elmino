# Server 与 SDK

`@elmino/api` 定义远程调用契约，`@elmino/server` 使用 Hono 承载 HTTP 路由、中间件与 CORS，oRPC 处理 API 契约、REST、RPC 与 OpenAPI。`@elmino/sdk` 提供 Node.js 与浏览器均可使用的客户端。它们复用现有 AgentEngine、RuntimeStore 和 Thread，不另起执行器

先通过 [03 · Elmino](elmino-example.md) 学习本地应用实例。远程调用教程按职责拆开：[04 · Server](server-example.md) 注册 Agent、连接真实 DeepSeek 并启动常驻服务；[05 · SDK](sdk-example.md) 通过独立客户端订阅事件、提交任务与查询持久化结果。两者各有自己的 `.env` 和启动入口

## 装配 Server

先定义应用实例，再把它交给 Server。模型、Agent、工作区和执行默认值归 Elmino，网络配置归 Server：

```ts
import { defineElmino } from '@elmino/core'
import { defineServer } from '@elmino/server'
import { sqliteStore } from '@elmino/store-sqlite'

const elmino = defineElmino({
  agents: { writer: agent },
  models: { deepseek: ({ frozenConfig }) => createModel(frozenConfig) },
  workspace: {
    id: 'my-workspace',
    rootDir: './workspace',
    store: sqliteStore(),
  },
})
const server = defineServer({ elmino })
const url = await server.start()
console.log(url)
```

`agent` 来自 `defineAgent()`；模型工厂返回的 `config.id` 应与注册键 `deepseek` 一致。恢复时按 `frozenConfig` 重建原模型并注入凭据。项目目录由宿主准备；首次访问才打开数据库，直到 `elmino.close()` 才释放存储租约。实例也能通过 `elmino.getAgent()` 和 `elmino.run()` 在本地使用，详见 [Elmino 应用实例](elmino.md)

`defineServer()` 默认使用 Hono，`await server.start()` 直接常驻监听，无需额外配置 HTTP 适配器。默认地址为 `http://127.0.0.1:3000`，返回实际监听地址；`port: 0` 可分配临时端口。首次 `start()` 确定配置，重复调用复用监听，关闭后重新定义 Server 即可继续接入同一个 Elmino

需要多工作区、动态模型目录和自定义鉴权时，分别配置：

```ts
const elmino = defineElmino({
  agents: { writer: agent },
  workspace: async ({ agentId, workspaceId, signal }) => ({
    store: await getStore(agentId, workspaceId, signal),
    location: ({ threadId, dir }) => getThreadLocation(workspaceId, threadId, dir),
  }),
  models: ({ modelId, frozenConfig, signal }) => frozenConfig
    ? restoreModel(frozenConfig, signal)
    : getModel(modelId, signal),
  onError: error => console.error('执行错误', error),
})
const server = defineServer({
  elmino,
  authorize: ({ request, input, path }) => authorizeRequest(request, path, input),
  onError: error => console.error('HTTP 错误', error),
  apiReference: { title: 'Writer API', version: '1.0.0' },
})
```

示例中的模型、存储、位置与身份函数由宿主提供。凭据、模型目录、用户身份与工作区根目录不从 HTTP 请求传入。Elmino 持有每个 Agent / 工作区的唯一 Engine，首次打开作用域时恢复运行事实；多个 Server 共享这份执行。各 Server 只维护自己的事件回放窗口

`RuntimeStore` 属于稳定工作区，动态回调返回的 Store 由宿主关闭。固定工作区的路径校验、模型选择顺序、冻结配置、执行默认值与附件预处理 `prepareInput()` 详见 [应用装配](elmino.md)

`apiKey` 对应 SDK 的同名字段，用于固定 Bearer 凭据校验；省略时读取 `ELMINO_SERVER_KEY`，两者均未配置则不启用固定凭据。显式 `apiKey: null` 可禁用环境凭据，空字符串仍视为错误。`authorize()` 在每个通过输入校验的 procedure 上执行，批处理中的调用分别授权。`input` 是已校验的请求，可用于限制 Agent、工作区或线程的访问范围。同时配置时先通过 `apiKey`，再执行资源授权；`authorize` 省略且没有有效 Key 时，框架不执行身份校验。`start()` 默认只监听本机，浏览器跨域通过 `corsOrigins` 明确配置允许的 Origin

## 环境变量与覆盖

入口使用 `@t3-oss/env-core` 校验自己消费的环境变量，优先级为显式参数 > 环境变量 > 默认值。无需在应用中逐层转发：

| 所属入口 | 环境变量 | 缺省行为 |
| --- | --- | --- |
| `defineServer()` | `ELMINO_SERVER_KEY` | 不启用固定 Bearer 凭据 |
| `defineServer()` | `ELMINO_CORS_ORIGINS` | 不开放浏览器跨域；有值时按逗号拆分完整 Origin |
| `server.start()` | `ELMINO_HOST` / `ELMINO_PORT` | `127.0.0.1:3000`，端口 `0` 表示随机端口 |
| `sqliteStore()` | `ELMINO_DATA_DIR` | 定义时当前目录下的 `.elmino` |

授权与 CORS 在定义实例时捕获，监听参数在首次 `start()` 时捕获，SQLite 目录在定义提供器时固定。之后修改环境不会改变已配置的实例。环境空字符串或空白视为未配置，值无效时在对应入口报错；被显式参数覆盖的环境值不参与校验

`apiKey: null`、`corsOrigins: []` 可显式关闭对应环境配置，`port: 0` 可覆盖环境端口。实例读取不修改 `process.env`，也不会自行搜索或加载 `.env`；文件加载由 Node 启动命令或宿主负责

SDK 浏览器入口不读取服务端环境或凭据。Node SDK 教程只在自己的入口读取 `ELMINO_SERVER_URL` 与可选 `ELMINO_SERVER_KEY`；连接地址默认 `http://127.0.0.1:3000`，不读取模型、存储或 Server 监听参数

## 扩展 Hono

普通服务定义后直接 `start()`。需要自定义接口或中间件时，通过可选的 `http(app)` 使用真实的 Hono API：

```ts
const server = defineServer({
  elmino,
  http(app) {
    // 同步注册中间件；处理请求的回调可以异步执行
    app.use('*', async (context, next) => {
      await next()
      context.header('X-App', 'writer')
    })
    // 自定义接口使用独立前缀，避免覆盖框架的 /api 与 /rpc
    app.get('/host/info', context => context.json({ name: 'writer-service' }))
  },
})

await server.start()
```

`http(app)` 在定义 Server 时执行一次，用于同步注册 `use()`、`get()`、`post()`、`route()` 等 Hono 能力；不要在其中异步打开存储或启动监听。它先于内置 API 注册，所以宿主中间件可以覆盖 REST、RPC、文档与事件订阅

框架的 CORS 与关闭门禁在宿主中间件之前执行。`corsOrigins` 使用 Hono 的 CORS 中间件和默认 HTTP 方法集合，同时作用于内置 API 与自定义接口；未配置时不开放跨域。预检不会进入业务鉴权，实际 API 请求继续按 oRPC procedure 分别检查权限，包括 batch 中的每一项

需要自定义允许的请求头、暴露头或 Cookie 策略时，配置 `corsOrigins: []` 关闭内置环境配置，在 `http(app)` 中自行注册 [Hono CORS 中间件](https://hono.dev/docs/middleware/builtin/cors)，由宿主管理完整跨域配置

`apiKey` 与 `authorize()` 约束框架 API；自定义接口的身份和资源授权由宿主 Hono 中间件负责。宿主可以调用 `app.onError()` 定义 HTTP 错误响应；默认处理器通过 `onError` 报告未处理异常并返回通用 500 响应，不暴露异常详情

自定义请求与内置 API 共用生命周期：关闭后新的业务请求返回 503；`server.close()` 结束自己的事件流、等待已进入的请求并关闭端口；共享 Engine 与存储仍归 Elmino。自定义长请求与流的结束由宿主负责；嵌入外部 HTTP 宿主时，还需关闭宿主自己的监听与连接

## HTTP 与交互文档

启动后打开 [http://127.0.0.1:3000/api/docs](http://127.0.0.1:3000/api/docs)，可以在 Scalar 中浏览接口、查看参数并发起请求。机器可读的 OpenAPI 定义位于 `/api/spec.json`

| 地址 | 用途 |
| --- | --- |
| `GET /api/docs` | Scalar 交互文档 |
| `GET /api/spec.json` | OpenAPI JSON 定义 |
| `GET /api/health` | 服务健康检查 |
| `GET /api/agents` | 已注册的 Agent 说明 |
| `GET /api/events` | 运行事件流，需要指定 Agent 和工作区 |

文档与定义默认可直接访问，只展示静态接口结构，不包含运行数据或凭据。REST 业务接口与 `/rpc` 共用同一个宿主 `authorize()`；配置了固定 Key 时，在 Scalar 的 Bearer 认证中填写自己的访问凭据。示例填写 `.env` 中的 `ELMINO_SERVER_KEY`；未配置时无需填写。自定义 `authorize` 或外层宿主使用其他身份机制时，按其规则提供身份

例如，通过 REST 检查示例服务：

```sh
curl -H 'Authorization: Bearer <ELMINO_SERVER_KEY>' \
  http://127.0.0.1:3000/api/health
```

配置固定 Key 时，将 `<ELMINO_SERVER_KEY>` 替换为自己的访问凭据；示例未配置时可以省略 `-H` 参数。成功时返回 `{"status":"ok"}`。浏览文档和健康检查不会调用模型；提交任务才会进入 Agent 执行

`apiReference` 不配置时使用标题 `Elmino API` 和版本 `0.0.0`；可像上面的装配示例一样设置 `title` 与 `version`。设置 `apiReference: false` 会同时关闭 `/api/docs` 和 `/api/spec.json`，REST 业务接口继续存在，并遵循原有鉴权

Scalar 中会展示接口用途、字段约束、示例，以及创建与恢复的接纳语义。文档复用实际校验契约；无固定 Key 时不标记必需 Bearer，自定义 `authorize` 的身份规则在服务说明中标明由宿主决定。Schema 的复用与维护方式见 [请求与事件协议](transport.md#schema-的归属与组合)

SDK 继续使用 `/rpc`，不需要因启用 REST 与文档而修改客户端配置

## 通过 SDK 调用

普通应用先绑定会话，后续发送、审批和控制都复用同一身份：

```ts
import { Client } from '@elmino/sdk'

const client = Client.create({ baseUrl: 'http://127.0.0.1:3000' })
const thread = client.thread({ agentId: 'writer', workspaceId: 'my-workspace' })
const result = await thread.run('请完成当前任务', {
  onText: delta => { process.stdout.write(delta) },
})

console.log(result.status, result.message)
await thread.run('继续总结刚才的结果')
```

配置固定访问凭据时向 `Client.create()` 传入 `apiKey`，动态认证使用异步 `headers`，自定义宿主可注入 `fetch`。SDK 可在 Node.js 和浏览器使用；实时页面订阅同一个 `ClientThread` 快照

`thread()` 不创建空会话，首次 `run()` 才持久化。SDK 分配缺省身份，等待事件连接就绪后只提交一次任务，观察终态并读取权威快照。结果包含 Agent、工作区、线程、Turn 身份，`status`、可选的本轮最后一条助手消息 `message`、完整 `thread`，以及待处理时的 `interaction`

| 用户目标 | 入口 |
| --- | --- |
| 发送或继续聊天 | `thread.run(input, options?)` |
| 启动并取得控制句柄 | `thread.start(input, options?)` |
| 运行中补充要求、停止 | `task.steer(text)`、`task.interrupt(reason?)` |
| 等待接纳或结束 | `task.accepted`、`task.completed` |
| 批准、拒绝或分项处理工具 | `thread.approve()`、`thread.reject()`、`thread.respond()` |
| 恢复其他自定义交互 | `thread.resume(interaction, response, options?)` |
| 取消整个待处理任务 | `thread.cancel(interaction, reason?, options?)` |
| 刷新后重新观察既有执行 | `thread.attach(turnId, options?)` |
| 完整状态与实时订阅 | `thread.get()`、`thread.getSnapshot()`、`thread.subscribe(listener)`、`thread.watch(listener, options?)` |
| 持久运行与分页历史 | `thread.listTurns()`、`thread.readTranscript({ cursor?, limit? })` |
| 草稿与本地发送队列 | `Composer.create({ thread })` |
| React 快照订阅 | `useThread(thread)`、`useComposer(composer)`，从 `@elmino/sdk/react` 引入 |
| 可选 Query utilities | `createApiQueryUtils(client)`，从 `@elmino/sdk/query` 引入 |
| 服务探活、Agent 和线程列表 | `client.health()`、`client.listAgents()`、`client.listThreads()` |

`run()` 与 `start()` 的可选配置包括服务端模型键 `modelId`、`approvalMode`、`subagentMode`、正文 / 思考 / 工具 / 事件回调以及本地等待 `signal`。恢复与重新观察不接受模型或权限覆盖。一次性调用仍可使用 `client.run({ agentId, workspaceId, input, ... })`，它复用同一个执行生命周期

`approve()`、`reject()`、`respond()` 和 `resume()` 与 `start()` 一样立即返回 `ClientRun`，等待恢复结果使用 `await thread.approve(interaction).completed`。恢复时也能继续停止、引导或结束本地观察；`cancel()` 仍直接等待取消事务的结果

执行结果 `status` 为 `completed`、`failed`、`cancelled` 或 `interrupted`；鉴权、请求与回调异常通过 Promise 拒绝返回。没有默认等待期限，`signal` 和 `task.detach()` 只结束本地观察，不自动停止远端任务，也不自动重试提交。停止活跃执行使用 `interrupt()`，取消待交互的整个任务使用 `cancel()`

输出回调只处理目标 Turn 的助手增量，断线或 reset 后通过快照补齐。`ClientThread` 统一维护消息与运行快照，`subscribe()`、异步 `watch()` 和可选 React Hook 都读取这份状态，同一 Client 的高级会话操作共享所属 Agent / 工作区的事件连接；每个观察者独立释放。Composer 只持有固定会话的草稿和队列，Query utilities 复用原 oRPC 客户端，不另外缓存实时消息。React 和 Query 的依赖均为可选，只在消费对应子入口时安装。完整调用与边界见 [SDK 运行控制](sdk-control.md)，最简单的真实模型调用见 [05 · SDK](sdk-example.md)

## 高级 RPC 与事件订阅

需要自行投影工作区事件或接入原始接口时，保留类型化的 `client.rpc` 与 `client.subscribe()`：

```ts
const target = { agentId: 'writer', workspaceId: 'my-workspace' }
const stop = client.subscribe(target, {
  onEvent: event => applyEvent(event),
  onReset: async () => reloadPersistedThreads(target),
  onConnected: () => console.log('事件连接已就绪'),
  onError: error => console.error('连接暂时中断', error),
})

// 不再观察时释放订阅；不会取消服务端任务
stop()
```

`applyEvent` 与 `reloadPersistedThreads` 由宿主提供。订阅可以先于线程创建，只传 Agent / 工作区目标；指定 `threadId` 时，Server 要求该线程已经存在。首次订阅会收到 `stream.reset`，应用应在 `onReset` 中重新读取持久化数据；只观察后续事件的调用方可以省略该回调。`onConnected` 在每次连接就绪并完成必要的 reset 处理后调用

| 调用 | 用途 |
| --- | --- |
| `client.run({ agentId, workspaceId, input, ... })` | 提交一次任务并等待终态与最终快照 |
| `rpc.meta.health({})` | 检查服务是否可访问 |
| `rpc.agent.list({})` | 读取注册的 Agent |
| `rpc.thread.list({ agentId, workspaceId, limit?, archived? })` | 读取轻量线程列表，返回 `items` 与 `hasMore` |
| `rpc.thread.get({ agentId, workspaceId, threadId })` | 读取完整持久化投影与当前流式内容 |
| `rpc.thread.listTurns({ agentId, workspaceId, threadId })` | 读取冻结执行策略与持久失败原因 |
| `rpc.thread.readTranscript({ agentId, workspaceId, threadId, cursor?, limit? })` | 按完整 Turn 分页读取消息，游标指向更早历史 |
| `rpc.turn.create({ ...target, threadId, turnId, input, ... })` | 提交新任务，可同时创建线程；返回仅表示已接纳 |
| `rpc.turn.resume({ ...target, threadId, turnId, interruptId, response })` | 恢复原中断，不覆盖冻结模型或权限 |
| `rpc.turn.cancel({ ...target, threadId, turnId, interruptId, reason? })` | 取消准确匹配的待交互运行，清除交互并固定取消终态 |
| `rpc.turn.interrupt({ ...target, threadId, turnId, reason? })` | 中断指定的当前任务 |
| `rpc.turn.steer({ ...target, threadId, turnId, text })` | 给指定活跃任务追加引导 |
| `client.subscribe({ ...target, threadId? }, handlers)` | 订阅事实，返回取消订阅函数 |

与 `run()` 等待完成不同，底层 `turn.create()` 在输入与启动事实持久化后就返回线程快照。HTTP 请求结束或调用 `stop()` 取消订阅不会停止任务；模型或工具稍后的失败通过事件和持久状态体现

远程调用沿用引擎的运行控制语义：`turn.steer()` 只接纳到指定活跃 Turn，补充要求在 Step 边界消费；`turn.interrupt()` 中断准确的 `turnId`。目标已结束或正在结算时，引导可能被拒绝。直接操作引擎的可运行示例见 [运行控制](agent-control.md)

列表沿用 RuntimeStore 的稳定前缀语义：需要更多条目时增大 `limit`，不使用虚构的列表游标。返回的轻量列表不携带完整消息；查看线程时再调用 `thread.get()`

## 重连与回放

SDK 在事件处理成功后才确认 SSE 游标。`onEvent` 或 `onReset` 失败时，下一次连接继续从之前确认的位置读取；应用处理器应允许同一事件重新投递，例如按事件 ID 去重或使用已有幂等片段投影

连接失败按有界指数退避重试，默认从 500 毫秒增长到 10 秒；可通过 `retry.initialDelayMs` 和 `retry.maxDelayMs` 调整。连续断线期间只通知一次 `onError`，观察器自身异常不会停止重连

每次 Server 进程新建事件流都会更换流 ID。游标过期、重放窗口不足或 Server 重启后，客户端收到 `stream.reset`。`run()`、`attach()` 和 `watch()` 自动查询目标线程快照；使用底层 `subscribe()` 时由宿主在 `onReset` 中读取。回放队列默认保留 8 MiB 序列化事件，可通过 `eventBufferBytes` 调整；它是进程内缓存，持久化事实仍归 Store

SDK 按顺序等待处理器，保持背压。取消订阅会取消当前请求、释放流读取器和重试计时器。SDK 不持有产品 UI 缓存；`ClientThread` 拥有唯一会话投影，执行句柄只维护单次观察的输出位置与完成判定，React Hook 直接订阅既有对象

## 关闭与所有权

```ts
stop()
const results = await Promise.allSettled([server.close(), elmino.close()])
throwSettledErrors(results, '关闭应用失败', true)
```

`throwSettledErrors` 从 `@elmino/shared` 导入。创建方分别关闭接入与应用实例：`server.close()` 拒绝新 HTTP 请求、结束自己的订阅、等待请求并关闭监听；`elmino.close()` 取消资源解析、结算执行、结束观察并释放存储配置租约。并行发起可让 Engine 取消解除尚未结束的请求，两者都等待完毕后再报告失败。关闭方法均可重复调用

一个 Elmino 可以接入多个 Server。关闭其中一个不会中断任务或关闭数据库；另一个 Server 与本地调用继续使用同一份资源。Server 启动失败也只清理自身。Elmino 关闭后，尚未关闭的 Server 拒绝新的业务请求

固定工作区的 `sqliteStore({ dataDir })` 租约由 Elmino 释放；直接传入的 Store 实例与动态工作区返回的 Store 仍由宿主在 Elmino 关闭后自行关闭。同一数据目录的并发调用应复用同一个配置对象

`start()` 默认的 `SIGINT` / `SIGTERM` 处理只关闭 Server。应用统一拥有 Elmino 和其他资源时，应关闭这项自动处理，自行协调退出；可运行示例已经提供完整流程：

```ts
await server.start({ port: 3000, shutdownSignals: false })
// 应用退出时等待 server.close() 与 elmino.close()
```

嵌入 Hono 或其他 Fetch 宿主时，挂载 `request => server.fetch(request)`，无需调用 `start()`，也不会注册信号。宿主关闭自己的监听，分别关闭 Server 与 Elmino

高级接入可从 `@elmino/server/node` 引入 `listen({ server, port, hostname })`：默认随机端口，仅管理网络，不注册信号。调用方分别关闭监听、Server 和 Elmino；不要对同一服务同时使用独立 `listen()` 和 `start()`
