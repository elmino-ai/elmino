# 04 · SDK

第四个教程使用独立客户端调用已经运行的 Server：建立连接、订阅事件、提交任务、等待终态、读取持久化结果，最后取消订阅并退出。这里不创建 Agent、不连接模型，也不打开服务端存储

示例位于 `examples/tutorial/04-sdk`，私有工作区包名为 `@example/sdk`。请先完成 [03 · Server](server-example.md)，在另一个终端保持 `pnpm example:server` 运行

## 配置客户端

在仓库根目录执行：

```sh
cp examples/tutorial/04-sdk/.env.example examples/tutorial/04-sdk/.env
```

本例只有两个连接配置：

```dotenv
ELMINO_SERVER_URL=http://127.0.0.1:3000
ELMINO_SERVER_KEY=
```

| 配置 | 用途与默认值 |
| --- | --- |
| `ELMINO_SERVER_URL` | Server 地址，默认 `http://127.0.0.1:3000`；不要追加 `/rpc` |
| `ELMINO_SERVER_KEY` | 可选访问凭据；服务端设置了 Key 时填写相同值，否则留空 |

这个 `.env` 只属于客户端，不从 Server 的目录读取配置，也不包含模型密钥、数据目录或监听参数。连接地址由本例入口读取；框架的浏览器 SDK 不自动读取 Node 环境变量

## 启动客户端

保持 Server 终端运行，在第二个终端执行：

```sh
pnpm example:sdk
```

命令先构建所需能力包，再启动 `@example/sdk`。也可以在依赖已经构建后，进入 `examples/tutorial/04-sdk` 执行 `pnpm start`

客户端提交任务，请服务端 Agent 读取当前时间，打印模型提供的可见思考、工具结果与回复，然后查询保存的线程并打印运行状态。输出正文和时间以真实模型返回为准：

```text
思考：
…模型返回的可见思考…
工具 current_time：…UTC 时间…
回复：
…模型的完成说明…
持久化 Turn 状态： completed
```

模型没有提供可见思考时，不会生成替代内容。本例在完整片段结束时打印一次；SDK 也能逐条接收正文、思考与工具输出增量。客户端完成后退出，Server 继续等待下一次请求

## 阅读调用流程

先看 [client/client.ts](../examples/tutorial/04-sdk/src/client/client.ts) 中的连接配置，再看 [app/run.ts](../examples/tutorial/04-sdk/src/app/run.ts) 的远程执行流程。SDK 通过公开入口创建：

```ts
import { Client } from '@elmino/sdk'

const client = Client.create({
  baseUrl: 'http://127.0.0.1:3000',
  // 只在服务端设置了访问 Key 时提供
  apiKey: serverKey,
})
```

客户端的 Agent 键 `clock` 和工作区键 `example` 必须与 Server 注册值一致。新任务通过 `createId('thread')` 和 `createId('turn')` 生成身份；后续查询和控制始终使用原值

主流程按下面的顺序运行：

1. 先订阅 Agent 工作区事件。新线程尚未创建，因此此时不按线程过滤；回调再核对目标线程与 Turn
2. 等待订阅建立，再调用 `client.rpc.turn.create()` 提交文本任务。接口返回表示任务已接纳，不代表模型或工具执行完成
3. 根据事件接收思考、回复、工具输出和运行终态。客户端只打印助手消息，并按片段身份去重
4. 收到完成终态后，调用 `client.rpc.thread.get()` 读取权威快照，确认持久化 Turn 为 `completed`
5. 在 `finally` 中调用订阅返回的 `stop()`，清除等待期限并结束客户端请求

```ts
await client.rpc.turn.create({
  agentId: 'clock',
  workspaceId: 'example',
  threadId,
  turnId,
  input: [{ type: 'text', text: '请调用工具读取 Server 当前时间，并说明远程调用已完成' }],
})

// 实际例子先通过订阅等到终态，再执行查询
const state = await client.rpc.thread.get({
  agentId: 'clock',
  workspaceId: 'example',
  threadId,
})
```

以上片段展示请求形状；订阅建立、超时、去重和异常清理由示例的完整流程处理，不能把 `turn.create()` 返回当作任务完成

## 重连与取消

SDK 自动重连事件订阅。收到 `stream.reset` 时，说明不能只靠当前游标继续回放，示例通过 `onReset` 重新查询线程快照，补齐断线期间已经完成的结果。首次连接时线程尚不存在，`NOT_FOUND` 是正常情况；其他错误仍需报告

本例最多等待 60 秒。达到期限会结束客户端等待与请求；取消订阅或客户端退出都不会自动停止已接纳的 Agent 任务。要停止指定运行，显式调用 `client.rpc.turn.interrupt()`，并继续观察其终态

## 浏览器调用

浏览器仍从 `@elmino/sdk` 创建 `Client`，显式提供 Server 地址与业务访问凭据。Server 的 `ELMINO_CORS_ORIGINS` 需要包含前端的完整来源，例如 `http://localhost:5173`

`DEEPSEEK_API_KEY` 只留在 Server，不能放入客户端或前端配置。`ELMINO_SERVER_KEY` 是本地示例的共享开发凭据；生产应用的身份与权限应由宿主通过 `authorize` 等入口提供

## 源码导航

| 想了解什么 | 文件 |
| --- | --- |
| 启动与入口错误处理 | [src/index.ts](../examples/tutorial/04-sdk/src/index.ts) |
| 仅客户端所属的连接配置 | [client/client.ts](../examples/tutorial/04-sdk/src/client/client.ts) |
| 订阅、提交、快照恢复、结果查询与取消 | [app/run.ts](../examples/tutorial/04-sdk/src/app/run.ts) |

完整 API、事件回放与鉴权配置见 [Server 与 SDK 指南](server-sdk.md)，协议与游标边界见 [请求与事件协议](transport.md)
