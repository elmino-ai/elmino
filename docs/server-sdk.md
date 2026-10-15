# Server 与 SDK

`@elmino/api` 定义远程调用契约，`@elmino/server` 提供标准 Fetch 服务，`@elmino/sdk` 提供 Node.js 与浏览器均可使用的客户端。它们复用现有 AgentEngine、RuntimeStore 和 Thread，不另起执行器

可运行代码见 [02-server-sdk 示例](server-sdk-example.md)，通过真实 DeepSeek 演示订阅、工具执行与持久化查询

## 装配 Server

```ts
import { AgentServer } from '@elmino/server'
import { listen } from '@elmino/server/node'

const server = AgentServer.create({
  agents: { writer: agent },
  workspace: async ({ agentId, workspaceId, signal }) => ({
    store: await getStore(agentId, workspaceId, signal),
    resolveLocation: ({ threadId, dir }) => getThreadLocation(workspaceId, threadId, dir),
  }),
  model: ({ modelId, frozenConfig, signal }) => frozenConfig
    ? restoreModel(frozenConfig, signal)
    : getModel(modelId, signal),
  authorize: ({ request, input, path }) => authorizeRequest(request, path, input),
  onError: error => console.error(error),
  apiReference: { title: 'Writer API', version: '1.0.0' },
})

const http = await listen({ server, hostname: '127.0.0.1', port: 3000 })
console.log(http.url)
```

`agent` 是 `defineAgent()` 的结果，示例中的 `getStore`、`getThreadLocation`、`getModel`、`restoreModel` 和 `authorizeRequest` 由宿主提供。凭据、模型目录、用户身份与工作区路径不从 HTTP 请求传入

Server 为每个 Agent / 工作区保留独立 Engine 和事件回放窗口。首次访问时调用 `recoverWorkspace()` 校准上次进程遗留的执行状态，并恢复可重新排队的子任务。资源解析失败不会缓存失败结果，后续请求可以重试；同一作用域在 Server 生命周期内复用同一个 Store

RuntimeStore 应属于一个工作区，不能把同一个实例挂到不同工作区 ID。多个 Agent 可在同一工作区使用同一 Store，线程的固定 Agent 归属仍由 Server 与 Engine 检查。宿主应在工作区打开前完成自己的长期数据迁移

`resolveLocation()` 接收已持久化的相对 `dir`，新线程没有该字段，由宿主决定初始位置。返回值使用现有 `ThreadLocation`，必须与目标工作区和已有目录一致。模型恢复必须使用 `frozenConfig`，不能因为默认模型或凭据配置发生变化而替换旧 Turn 的模型语义

`authorize()` 在每个通过输入校验的 procedure 上执行，批处理中的调用分别授权。`input` 是已校验的请求，可用于限制 Agent、工作区或线程的访问范围。省略该回调表示宿主已在外层完成授权；`listen()` 默认只监听本机。浏览器跨域调用通过 `corsOrigins` 明确配置允许的 Origin

文本、引用和原始图片可以直接进入 Engine。文档解析或图片压缩由可选的 `prepareInput()` 完成，返回 `TurnInputPart[]`；它在 Engine 的入口预留期间执行，避免重复请求提前产生文档产物。省略时文档请求会被拒绝，图片按原始内容发送

## HTTP 与交互文档

启动后打开 [http://127.0.0.1:3000/api/docs](http://127.0.0.1:3000/api/docs)，可以在 Scalar 中浏览接口、查看参数并发起请求。机器可读的 OpenAPI 定义位于 `/api/spec.json`

| 地址 | 用途 |
| --- | --- |
| `GET /api/docs` | Scalar 交互文档 |
| `GET /api/spec.json` | OpenAPI JSON 定义 |
| `GET /api/health` | 服务健康检查 |
| `GET /api/agents` | 已注册的 Agent 说明 |
| `GET /api/events` | 运行事件流，需要指定 Agent 和工作区 |

文档与定义默认可直接访问，只展示静态接口结构，不包含运行数据或凭据。REST 业务接口与 `/rpc` 共用同一个宿主 `authorize()`；在 Scalar 的 Bearer 认证中填写自己的访问凭据后即可调试。运行示例时填写 `.env` 中的 `SERVER_KEY`

例如，通过 REST 检查示例服务：

```sh
curl -H 'Authorization: Bearer <SERVER_KEY>' \
  http://127.0.0.1:3000/api/health
```

将 `<SERVER_KEY>` 替换为自己的访问凭据，成功时返回 `{"status":"ok"}`。浏览文档和健康检查不会调用模型；提交任务才会进入 Agent 执行

`apiReference` 不配置时使用标题 `Elmino API` 和版本 `0.0.0`；可像上面的装配示例一样设置 `title` 与 `version`。设置 `apiReference: false` 会同时关闭 `/api/docs` 和 `/api/spec.json`，REST 业务接口继续存在，并遵循原有鉴权

SDK 继续使用 `/rpc`，不需要因启用 REST 与文档而修改客户端配置

## 通过 SDK 调用

```ts
import { Client } from '@elmino/sdk'
import { createId } from '@elmino/shared'

const client = Client.create({
  baseUrl: 'http://127.0.0.1:3000',
  apiKey: accessToken,
})
const target = { agentId: 'writer', workspaceId: 'my-workspace' }
const threadId = createId('thread')
const turnId = createId('turn')

const stop = client.subscribe(target, {
  onEvent: event => applyEvent(event),
  onReset: async () => reloadPersistedThreads(target),
  onError: error => console.error('连接暂时中断', error),
})

const thread = await client.rpc.turn.create({
  ...target,
  threadId,
  turnId,
  input: [{ type: 'text', text: '请完成当前任务' }],
})
```

`accessToken`、`applyEvent` 和 `reloadPersistedThreads` 由应用提供。可以使用异步 `headers` 代替固定 `apiKey`，以及注入自定义 `fetch`。所有具体方法直接通过类型化的 `client.rpc` 调用，不重复维护一套转发方法

订阅可以先于线程创建，只传 Agent / 工作区目标；指定 `threadId` 时，Server 要求该线程已经存在。首次订阅会收到 `stream.reset`，应用应在 `onReset` 中重新读取持久化数据；不维护本地状态、只观察后续事件的调用方可以省略该回调

`turn.create()` 在输入与启动事实已持久化后返回线程快照，不等待模型完成。HTTP 请求结束或调用 `stop()` 取消订阅不会停止任务；模型或工具稍后的失败通过事件和持久状态体现

| 调用 | 用途 |
| --- | --- |
| `rpc.meta.health({})` | 检查服务是否可访问 |
| `rpc.agent.list({})` | 读取注册的 Agent |
| `rpc.thread.list({ agentId, workspaceId, limit?, archived? })` | 读取轻量线程列表，返回 `items` 与 `hasMore` |
| `rpc.thread.get({ agentId, workspaceId, threadId })` | 读取完整持久化投影与当前流式内容 |
| `rpc.turn.create({ ...target, threadId, turnId, input, ... })` | 提交新任务，可同时创建线程 |
| `rpc.turn.resume({ ...target, threadId, turnId, interruptId, response })` | 恢复原中断，不覆盖冻结模型或权限 |
| `rpc.turn.interrupt({ ...target, threadId, turnId, reason? })` | 中断指定的当前任务 |
| `rpc.turn.steer({ ...target, threadId, turnId, text })` | 给指定活跃任务追加引导 |
| `client.subscribe({ ...target, threadId? }, handlers)` | 订阅事实，返回取消订阅函数 |

列表沿用 RuntimeStore 的稳定前缀语义：需要更多条目时增大 `limit`，不使用虚构的列表游标。返回的轻量列表不携带完整消息；查看线程时再调用 `thread.get()`

## 重连与回放

SDK 在事件处理成功后才确认 SSE 游标。`onEvent` 或 `onReset` 失败时，下一次连接继续从之前确认的位置读取；应用处理器应允许同一事件重新投递，例如按事件 ID 去重或使用已有幂等片段投影

连接失败按有界指数退避重试，默认从 500 毫秒增长到 10 秒；可通过 `retry.initialDelayMs` 和 `retry.maxDelayMs` 调整。连续断线期间只通知一次 `onError`，观察器自身异常不会停止重连

每次 Server 进程新建事件流都会更换流 ID。游标过期、重放窗口不足或 Server 重启后，客户端收到 `stream.reset`，由应用重新读取权威快照。回放队列默认保留 8 MiB 序列化事件，可通过 `eventBufferBytes` 调整；它是进程内缓存，持久化事实仍归 Store

SDK 按顺序等待处理器，保持背压。取消订阅会取消当前请求、释放流读取器和重试计时器。SDK 不持有 React 状态、UI 缓存或额外线程副本

## 关闭与所有权

```ts
stop()
await server.close()
await http.close()
await store.close()
```

Server 关闭会拒绝新操作，通知尚未完成的宿主资源解析取消，等待已有入口与 Engine 结算，再关闭事件流。`close()` 可重复调用；宿主异步解析器需要遵守提供的 `signal` 或自行结束等待

Server 不关闭传入的 Store 或 BlobStore。调用方应先关闭 Server 和 HTTP 连接，再关闭自己创建的存储。Node 监听器的 `close()` 只关闭网络连接；关闭监听器不会代替 `server.close()` 的执行结算

Server 提供 REST、oRPC 与事件流。接入其他 HTTP 框架时可以直接挂载 `server.fetch()`
