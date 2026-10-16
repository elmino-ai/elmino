# 请求与事件协议

通用请求和事件传输能力可以独立使用，也被 `@elmino/api`、`@elmino/server` 和 `@elmino/sdk` 复用。完整远程装配见 [Server 与 SDK](server-sdk.md)，独立运行入口分别见 [Server 教程](server-example.md) 与 [SDK 教程](sdk-example.md)

## 包的职责

| 包或入口 | 职责 |
| --- | --- |
| `@elmino/schema` | 无业务依赖的字符串、HTTP 地址、精确来源与端口字段校验 |
| `@elmino/request` | 绑定基础地址、动态默认 Header、标准 Fetch 和 HTTP 错误解析 |
| `@elmino/request/orpc` | 将上述传输接入类型化 oRPC，控制批处理范围 |
| `@elmino/protocol` | 校验跨端事件、线程快照和控制消息，处理 JSON 与事件流游标 |
| `@elmino/thread/events` | Thread 已有的领域事件、工厂与片段读取；传输层复用的浏览器入口 |

模型消息继续归 `llm`，持久化契约继续归 `store`，线程与执行事件类型继续归 `thread`。`protocol` 引用这些类型，定义外部传输边界的 Schema，不把内核改为依赖 HTTP 或 SDK

旧 `protocol` 中的账号、模型目录、工作区管理、产品设置和 UI 状态没有迁入。这些能力不属于通用 Agent 引擎。宿主自己的 Agent、模型和工作区配置键不强制使用旧产品的 ID 格式；内核生成的 Thread、Turn、Message、Tool、Interrupt 和 Event ID 继续在外部边界校验 UUID v4

## Schema 的归属与组合

通用字段从 `@elmino/schema` 引入，默认值与输入转换由实际入口决定：

```ts
import { HttpUrlSchema, PortSchema, TrimmedStringSchema } from '@elmino/schema'
import { z } from 'zod'

const connectionSchema = z.object({
  url: HttpUrlSchema,
  hostname: TrimmedStringSchema.default('127.0.0.1'),
  port: z.coerce.number().pipe(PortSchema).default(3000),
})
```

`PortSchema` 只接受数值端口 1–65535；监听时需要允许系统分配端口，改用 `ListenPortSchema` 接受 0。`HttpUrlSchema` 接受 HTTP / HTTPS 地址，`HttpOriginSchema` 要求精确浏览器来源，不接受路径、末尾斜杠或凭据；逗号列表的解析仍留在环境配置入口

`NonBlankStringSchema` 拒绝空白但保留原文，适合宿主配置键；`TrimmedStringSchema` 明确裁剪首尾空白，适合允许归一化的配置。不能为了减少代码把消息或身份字段自动 trim，也不把工具名、注册键与内核 ID 混成一类

Thread、Turn、Message、Interrupt 等领域 ID 从 `@elmino/protocol` 的具名 Schema 引入，仍沿用各自的前缀和 UUID 规则。API 复用这些字段组成 strict 请求对象，并通过最终 Schema 推导类型。复用 `.shape` 时需要保留对象的 strict、refinement 与 catchall 约束，不能只复制字段而丢掉边界语义

`/api/docs` 的接口说明来自契约 `route.description`，字段说明和示例来自 Schema 的 `.describe()`、`.meta({ examples })`。代码 JSDoc 供源码阅读，不会自动生成接口字段说明。自定义 JSON 与消息片段的文档结构仍由领域 Schema 提供，Server 只合并调用场景添加的说明与示例；不会单独维护第二份请求结构

## 使用请求层

```ts
import { createRequest, HttpError } from '@elmino/request'

const request = createRequest({
  system: 'my-app',
  baseUrl: 'https://agent.example.com/api',
  // 每次请求重新读取，可接异步凭据刷新
  headers: () => ({ authorization: `Bearer ${getAccessToken()}` }),
})

try {
  const response = await request.fetch('/health', {
    signal: AbortSignal.timeout(5_000),
  })
  console.log(await response.json())
}
catch (error) {
  if (error instanceof HttpError)
    console.error(error.status, error.code, error.message)
  else
    throw error
}
```

这里的地址、业务端点和 `getAccessToken()` 由应用提供。相对地址按基础地址前缀拼接，上例请求 `/api/health`；绝对地址按原地址发送。默认 Header 只注入同源请求，跨域绝对地址不继承默认鉴权，调用点显式 Header 优先

`fetch` 将非成功响应解析为 `HttpError`，网络异常和取消仍保留原始异常。`rawFetch` 只注入地址与 Header，保留状态码和未读取的响应正文，供 oRPC 或其他传输协议自己解析。可以用 `decodeError` 接入宿主的错误格式，或用 `fetch` 配置注入自己的标准 Fetch 实现

`withBaseUrl()` 派生新的服务前缀，复用当前动态凭据和错误策略；应传入应用自己信任的服务地址

### oRPC 子入口

```ts
import { createOrpcClient } from '@elmino/request/orpc'

const rpc = createOrpcClient<MyApiClient>(request.withBaseUrl(
  'https://agent.example.com/rpc',
), {
  batch: {
    // 长连接、事件流、下载等 procedure 需要独立发送
    exclude: path => path[0] === 'events',
  },
})
```

`MyApiClient` 来自应用自己的 oRPC 契约；调用框架接口时可用 `@elmino/api` 的 `ApiClient`。oRPC 使用 `rawFetch`，保留自己的错误与事件迭代器语义。批处理默认开启，最多每批 10 个调用；事件订阅等长连接必须通过 `exclude` 排除

基础请求入口不会加载 oRPC 适配代码。包本身声明 `@orpc/client` 运行依赖，因此安装 `request` 仍会安装该依赖；子路径区分代码引入边界

oRPC 1.15 的公开声明引用了可选 peer `@opentelemetry/api`。为了让独立消费项目在 `skipLibCheck: false` 下正常检查，`request` 显式声明该依赖；本包没有配置或启动遥测上报

## 运行事件与 JSON

```ts
import { parseRuntimeEventJson, serializeRuntimeEvent } from '@elmino/protocol'
import { createRuntimeEvent } from '@elmino/thread/events'
import { createId } from '@elmino/shared'

const event = createRuntimeEvent({
  type: 'turn.completed',
  threadId: createId('thread'),
  turnId: createId('turn'),
  payload: { unreadAt: new Date().toISOString() },
})

const text = serializeRuntimeEvent(event)
const received = parseRuntimeEventJson(text)
```

`RuntimeEventSchema` 校验事件外壳、领域载荷与 Thread / Turn / Message / Part 的归属。`ThreadStateSchema`、`ThreadMessageSchema`、`ThreadPartWireSchema` 等公开 Schema 可以供 API 的输入输出复用。内部调用链沿用原有领域类型，不在每层重复执行外部校验

`isRuntimeEvent()`、`isRuntimeStreamMessage()` 与 JSON 解析使用同一套载荷判定，避免 Server 输出与 SDK 接收使用不同标准。消息、完整片段、增量、线程快照、子线程、中断、用量与上下文预算均按实际载荷校验

解析失败返回 `undefined`，序列化失败抛出 `TypeError`。对象中的可选 `undefined` 字段按标准 JSON 语义省略；循环引用、函数、BigInt、非有限数字、Date、Map 和包含空位置的数组会拒绝传输，避免静默改变运行事实。扩展数据使用普通 JSON 值

## 事件流与恢复游标

运行流的消息类型为 `RuntimeEvent | RuntimeStreamControl`，控制消息只有：

- `stream.connected`：连接建立
- `stream.reset`：回放无法续接，客户端需要重新读取持久化快照

游标承载在 SSE `id`，重连通过 `Last-Event-ID` 提交，与领域事件的 `event.id` 分开：

```ts
import { createRuntimeEventCursor, parseRuntimeEventCursor } from '@elmino/protocol'
import { createId } from '@elmino/shared'

const streamId = createId('stream')
const cursor = createRuntimeEventCursor({ streamId, sequence: 42 })
const position = parseRuntimeEventCursor(cursor)
```

格式为 `<stream UUID>:<非负安全整数>`。每次 Server 创建新事件流时重新生成 `streamId`；Server 持有回放窗口并判断游标是否属于本流、是否落在可回放范围。`protocol` 仅校验语法，不拥有队列、连接或持久化资源

Server 负责回放与 `reset`，SDK 在回调处理成功后推进游标，并负责断线重连和取消订阅。这些运行生命周期不归协议包

## 上层调用

`api` 契约引用这些 Schema，Elmino 装配模型、Store 与 Runtime，Server 借用实例并提供鉴权，纯 SDK 复用请求层并处理事件重连。审批恢复、断线重连与 Server 重建沿用持久化执行事实，详情见 [Server 与 SDK 指南](server-sdk.md)
