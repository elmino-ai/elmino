# 03 · Server 与 SDK

第三个示例通过常驻 Server 提供 Agent，再由独立的 SDK 客户端通过 HTTP / SSE 提交任务、接收思考与工具事件，最后查询 SQLite 保存的线程结果。客户端完成后退出，Server 继续等待下一次调用

## 配置

在仓库根目录执行：

```sh
cp examples/tutorial/03-server-sdk/.env.example examples/tutorial/03-server-sdk/.env
```

在新建的 `.env` 中填写 `DEEPSEEK_API_KEY` 与 `SERVER_KEY`，两项都必填。该文件只属于这个示例，已被 Git 忽略；仓库不会从其他示例复制密钥

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
SERVER_KEY=your-development-server-key
PORT=3000
HOST=127.0.0.1
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

模型采用真实 DeepSeek，通过 Anthropic Messages 接口调用。启动 Server 不会调用模型；SDK 客户端提交任务后才开始执行

| 配置 | 用途与默认值 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 服务端模型凭据，必填 |
| `DEEPSEEK_MODEL` | 模型名称，默认 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | 模型服务地址，默认 `https://api.deepseek.com/anthropic` |
| `SERVER_KEY` | Server 与客户端共享的开发访问凭据，必填 |
| `PORT` | Server 监听端口，默认 `3000` |
| `HOST` | Server 监听地址，默认 `127.0.0.1` |
| `SERVER_URL` | 可选，覆盖 SDK 客户端连接的 Server 地址 |
| `DATA_DIR` | 可选，默认使用示例目录下的 `.elmino` 保存运行数据 |
| `CORS_ORIGINS` | 允许的前端来源，使用逗号分隔，默认 `http://localhost:5173,http://127.0.0.1:5173` |

## Server 定义

示例在 `app/run.ts` 准备工作区并调用框架入口，定义后直接启动：

```ts
const server = defineServer({
  agents: { clock },
  workspace: { id: 'example', rootDir: workspaceRoot, store: sqliteStore({ dataDir: config.dataDir }) },
  model: ({ frozenConfig }) => createModel(frozenConfig),
  apiKey: config.key,
  corsOrigins: config.corsOrigins,
})
const url = await server.start({ port: config.port, hostname: config.hostname })
```

`defineServer` 来自 `@elmino/server`，`start()` 直接打开监听并返回实际地址。框架默认处理 Ctrl+C / SIGTERM 和统一关闭，无需手写退出流程；应用主动关闭时调用 `await server.close()`。固定工作区无需手写位置回调，`apiKey` 与 SDK 的同名字段对应；动态资源和自定义鉴权仍可使用回调，见 [Server 与 SDK 指南](server-sdk.md)

## 双终端运行

第一个终端在仓库根目录启动 Server：

```sh
pnpm example:server-sdk
```

默认服务地址为 `http://127.0.0.1:3000`，启动日志会同时打印文档地址 [http://127.0.0.1:3000/api/docs](http://127.0.0.1:3000/api/docs)。启动后保持这个终端运行，Server 不会自动提交任务或退出

第二个终端在仓库根目录运行 SDK 客户端：

```sh
pnpm example:server-sdk:client
```

也可以分别在 `examples/tutorial/03-server-sdk` 目录执行 `pnpm start` 和 `pnpm client`。两个命令都加载这个示例自己的 `.env`

客户端先订阅事件，再提交读取服务端时间的任务。Agent 通过 `current_time` 工具获取时间，客户端打印模型提供的可见思考、工具结果和回复，查询持久化线程并打印 Turn 状态，然后关闭订阅并退出

客户端输出结构如下，模型正文与时间以实际返回为准：

```text
思考：
…模型返回的可见思考…
工具 current_time：…UTC 时间…
回复：
…模型的完成说明…
持久化 Turn 状态： completed
```

模型未提供可见思考时，不会生成替代文本。本例在完整片段完成后打印一次，SDK 本身也支持逐条接收正文、思考和工具输出增量

Server 通过 `store: sqliteStore({ dataDir })` 配置 `DATA_DIR` 中的 SQLite 与本地文件内容存储，按需打开并在关闭时自动释放，重启时复用同一目录。默认目录为 `examples/tutorial/03-server-sdk/.elmino`，运行数据不会加入 Git。客户端退出不会关闭 Server；在 Server 所在终端按 `Ctrl+C`，会等待 Server、HTTP 服务和 Store 完成关闭

## 浏览与调试 API

启动 Server 后，可以直接打开 `/api/docs` 查看 Scalar 交互文档，或读取 `/api/spec.json` 获取 OpenAPI 定义。这两个地址不需要访问凭据，内容只包含静态接口结构

在 Scalar 的 Bearer 认证中填写示例 `.env` 里的 `SERVER_KEY` 后，即可调用健康检查、Agent、线程和任务接口。模型凭据仍只留在服务端

也可以直接检查服务：

```sh
curl -H 'Authorization: Bearer <SERVER_KEY>' \
  http://127.0.0.1:3000/api/health
```

将 `<SERVER_KEY>` 替换为自己的开发访问凭据，成功时返回 `{"status":"ok"}`。打开文档或检查健康状态不会调用模型，提交任务才开始执行

文档的标题、版本和关闭方式见 [Server 与 SDK 指南](server-sdk.md#http-与交互文档)。关闭文档不会关闭 REST 接口；SDK 客户端继续通过 `/rpc` 调用

## 前端连接

前端也可以连接同一个 Server 地址，使用 SDK 调用 `/rpc`。开发前端来源需要出现在 `CORS_ORIGINS` 中；修改配置后重启 Server

`DEEPSEEK_API_KEY` 只留在服务端，不能放进前端配置。`SERVER_KEY` 是本例的共享开发凭据，命令行客户端从本地 `.env` 读取，不提交到 Git。前端接入时同样需要提供访问凭据；生产鉴权应通过宿主注入，见 [Server 与 SDK 指南](server-sdk.md)

## 源码导航

| 职责 | 文件 |
| --- | --- |
| Server 启动和入口错误处理 | [src/index.ts](../examples/tutorial/03-server-sdk/src/index.ts) |
| 常驻服务与资源关闭 | [app/run.ts](../examples/tutorial/03-server-sdk/src/app/run.ts) |
| 连接地址、数据目录与前端来源配置 | [app/config.ts](../examples/tutorial/03-server-sdk/src/app/config.ts) |
| SDK 客户端启动和入口错误处理 | [client/index.ts](../examples/tutorial/03-server-sdk/src/client/index.ts) |
| Agent 定义 | [agent/clock.ts](../examples/tutorial/03-server-sdk/src/agent/clock.ts) |
| SDK 订阅、提交、重建与结果查询 | [client/run.ts](../examples/tutorial/03-server-sdk/src/client/run.ts) |
| 真实 DeepSeek 适配器 | [model/deepseek.ts](../examples/tutorial/03-server-sdk/src/model/deepseek.ts) |
| Runtime 与本地执行环境 | [runtime/runtime.ts](../examples/tutorial/03-server-sdk/src/runtime/runtime.ts) |
| 只读时间工具 | [tool/current-time.ts](../examples/tutorial/03-server-sdk/src/tool/current-time.ts) |

`onReset` 在回放不能续接时重新读取权威线程。普通断网由 SDK 自动重连；取消订阅不会取消已经接纳的任务。需要中断任务时使用 `client.rpc.turn.interrupt()`

仓库的确定性测试使用测试模型覆盖相同 HTTP 流程、断网回放与 Server 重建恢复，不读取 `.env`，不依赖 API Key 或外部模型服务
