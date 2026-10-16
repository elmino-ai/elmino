# 05 · SDK

第五个教程使用 `client.thread()` 绑定远端 Agent 与工作区，再用 `thread.run()` 完成一次调用。SDK 负责订阅、提交、重连、等待结果和释放订阅，客户端只处理输入和输出

示例位于 `examples/tutorial/05-sdk`。请先完成 [04 · Server](server-example.md)，在另一个终端保持 `pnpm example:server` 运行。本教程只演示读取服务端时间；审批、停止和刷新后恢复观察见 [SDK 运行控制](sdk-control.md)

## 配置与启动

在仓库根目录执行：

```sh
cp examples/tutorial/05-sdk/.env.example examples/tutorial/05-sdk/.env
```

客户端只读取自己的连接配置：

```dotenv
ELMINO_SERVER_URL=http://127.0.0.1:3000
ELMINO_SERVER_KEY=
```

| 配置 | 用途与默认值 |
| --- | --- |
| `ELMINO_SERVER_URL` | Server 地址，默认 `http://127.0.0.1:3000`；不要追加 `/rpc` |
| `ELMINO_SERVER_KEY` | 可选访问凭据；服务端设置了 Key 时填写相同值，否则留空 |

这里不放模型密钥、数据目录或监听参数。文件由 Node 启动命令加载，浏览器 SDK 不读取 Node 环境变量。准备后在第二个终端运行：

```sh
pnpm example:sdk
```

命令先构建所需能力包，再启动客户端。依赖已经构建时，也可以进入 `examples/tutorial/05-sdk` 执行 `pnpm start`

## 绑定会话并发送任务

普通用法只需要连接、绑定、调用：

```ts
import { Client } from '@elmino/sdk'

const client = Client.create({ baseUrl: 'http://127.0.0.1:3000' })
const thread = client.thread({ agentId: 'clock', workspaceId: 'example' })
const result = await thread.run('读取当前时间')

console.log(result.status)
console.log(result.message)
```

服务端配置了固定 Key 时，在 `Client.create()` 中增加 `apiKey`。`agentId` 和 `workspaceId` 必须与服务端注册值一致。`thread()` 只在客户端绑定身份，首次 `run()` 才创建服务端记录，不会产生空会话

`run()` 等到本轮结束并读取权威快照后返回。`result.message` 是本轮最后一条助手消息，可能不存在；`result.thread` 包含完整会话历史、工具结果和运行状态。`status` 为 `completed`、`failed`、`cancelled` 或 `interrupted`；执行失败和等待审批正常返回，连接、鉴权、请求或输出回调错误使 Promise 拒绝

继续聊天时，直接复用同一个对象：

```ts
await thread.run('总结刚才的结果')
```

这是在同一会话创建新 Turn。恢复等待审批的原 Turn 使用 `approve()` 等交互方法，它们立即返回运行句柄，再通过 `completed` 等待结果：

```ts
if (result.interaction?.approval) {
  const resumed = thread.approve(result.interaction)
  const next = await resumed.completed
  console.log(next.status)
}
```

实际应用先展示审批内容，用户决定后才调用批准或拒绝。恢复期间的引导、停止与取消见 [SDK 运行控制](sdk-control.md#处理审批与其他交互)

## 按需展示实时输出

不需要实时展示时可以省略所有回调。示例在普通调用上增加输出与本地等待期限：

```ts
const result = await thread.run('读取当前时间', {
  onText: delta => { process.stdout.write(delta) },
  onReasoning: delta => { process.stdout.write(delta) },
  onToolResult: part => console.log('工具结果', part),
  signal: AbortSignal.timeout(60_000),
})
```

`process.stdout` 用于 Node 终端。浏览器页面优先订阅会话的完整快照，React 可使用下文的薄 Hook。`onText`、`onReasoning` 只输出目标 Turn 的助手增量，不混入用户输入或其他任务；模型没有返回可见思考时，不生成替代内容。`onToolResult` 每个可见工具片段通知一次完整终态结果，包含失败与跳过

临时断线由 SDK 重连，必要时读取持久快照补齐缺失输出。补发可能是一整段尚未展示的尾部，不依赖分块大小。异步回调按序等待，回调抛错时结束本地观察并释放订阅

`run()` 没有默认等待期限。超时或取消 `signal` 只结束本地等待，不自动停止已接纳的远端任务，也不会重新提交任务。需要运行过程中控制时改用 `thread.start()`，详见 [SDK 运行控制](sdk-control.md#启动引导与停止)

## 示例输出

示例请求服务端 Agent 调用 `current_time`，打印真实模型返回的可见思考、工具结果与回复：

```text
思考：
…模型返回的可见思考…
工具 current_time：…UTC 时间…
回复：
…模型的完成说明…
持久化 Turn 状态： completed
```

输出正文与顺序以真实模型返回为准。完成后客户端退出，Server 继续等待请求。示例返回完整线程状态供测试验收，不额外发起第二次历史查询

## 浏览器调用

浏览器同样从 `@elmino/sdk` 创建客户端，显式提供 Server 地址与业务访问凭据。Server 的 `ELMINO_CORS_ORIGINS` 需要包含前端完整来源，例如 `http://localhost:5173`

`DEEPSEEK_API_KEY` 只留在服务端。`ELMINO_SERVER_KEY` 是本地示例的共享开发凭据；生产应用的身份与权限由宿主通过 `authorize` 等入口提供

页面通过 `thread.subscribe(listener)` 订阅，并从 `thread.getSnapshot()` 读取同一份消息、连接状态和错误。需要输入草稿与本地发送队列时，使用 `Composer.create({ thread })`；React 从 `@elmino/sdk/react` 使用 `useThread(thread)` 和 `useComposer(composer)`，Query 从 `@elmino/sdk/query` 使用 `createApiQueryUtils(client)`。这些可选入口不要求基础 SDK 安装 React 或 TanStack Query，完整用法见 [草稿与本地队列](sdk-control.md#草稿与本地队列) 和 [可选 React 与 Query 接入](sdk-control.md#可选-react-与-query-接入)

## 源码导航

| 想了解什么 | 文件 |
| --- | --- |
| 启动与入口错误处理 | [src/index.ts](../examples/tutorial/05-sdk/src/index.ts) |
| 客户端连接配置 | [client/client.ts](../examples/tutorial/05-sdk/src/client/client.ts) |
| 绑定会话、实时输出与结果处理 | [app/run.ts](../examples/tutorial/05-sdk/src/app/run.ts) |

完整能力见 [SDK 运行控制](sdk-control.md)，HTTP、鉴权与原始接口见 [Server 与 SDK](server-sdk.md)，事件和游标边界见 [请求与事件协议](transport.md)
