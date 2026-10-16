# 03 · Server

第三个教程把前面学到的 Agent 包装为常驻 HTTP 服务。本例只讲服务端：定义 Agent、连接真实模型、配置持久化、启动服务和关闭资源。下一篇 [04 · SDK](sdk-example.md) 使用独立客户端连接这个 Server

## 学习目标与运行结果

运行后，终端打印服务地址、API 文档地址、Agent 键 `clock` 与工作区键 `example`，然后保持运行。启动过程检查模型配置，但不会调用模型或自动提交任务；收到客户端请求后，Agent 才调用 `current_time` 读取服务端 UTC 时间

示例位于 `examples/tutorial/03-server`，私有工作区包名为 `@example/server`。它通过公开的 `@elmino/*` 入口使用框架，不属于发布包

## 配置服务端

在仓库根目录执行：

```sh
cp examples/tutorial/03-server/.env.example examples/tutorial/03-server/.env
```

在新建的 `.env` 中填写必需的 `DEEPSEEK_API_KEY`。模型通过 Anthropic Messages 接口调用真实 DeepSeek；模型凭据只由服务端读取，不发送给客户端

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
ELMINO_HOST=127.0.0.1
ELMINO_PORT=3000
ELMINO_SERVER_KEY=your-development-server-key
ELMINO_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

真实 `.env` 已被 Git 忽略；仓库只保存不含真实密钥的 `.env.example`

| 配置 | 用途与默认值 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 模型凭据，必填 |
| `DEEPSEEK_MODEL` | 模型名称，默认 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | 模型服务地址，默认 `https://api.deepseek.com/anthropic` |
| `ELMINO_HOST` | 监听地址，默认 `127.0.0.1` |
| `ELMINO_PORT` | 监听端口，默认 `3000` |
| `ELMINO_SERVER_KEY` | 可选固定访问凭据；配置后，客户端需要提供同值；留空不启用固定凭据 |
| `ELMINO_DATA_DIR` | 可选运行数据目录，默认启动目录下的 `.elmino`；教程命令的启动目录为 `03-server` |
| `ELMINO_CORS_ORIGINS` | 可选，逗号分隔的完整浏览器来源；未配置不开放跨域 |

Server 自动读取监听、访问凭据和 CORS 配置，`sqliteStore()` 自动读取数据目录，不需要从入口逐层传递。显式参数优先于环境变量，再使用默认值；`.env` 的加载由示例自己的启动命令负责

## 装配 Agent 与应用实例

从 [app/run.ts](../examples/tutorial/03-server/src/app/run.ts) 开始阅读。核心装配如下：

```ts
const elmino = defineElmino({
  // 客户端通过 agentId: 'clock' 选择这个 Agent
  agents: { clock },
  // 使用稳定模型键；恢复时按原 Turn 的快照重建模型
  models: { deepseek: ({ frozenConfig }) => createModel(frozenConfig) },
  // 客户端使用 workspaceId: 'example'；存储按需打开
  workspace: { id: 'example', rootDir: workspaceRoot, store: sqliteStore() },
})

const server = defineServer({ elmino })
const url = await server.start({ shutdownSignals: false })
```

`defineElmino` 来自 `@elmino/core`，管理 Agent、模型、工作区、Engine 和存储配置租约。`defineServer` 来自 `@elmino/server`，借用这份实例提供 HTTP 接入，默认使用 Hono。Agent 定义负责提示词、工具与 Runtime；客户端只提交任务和作用域键，不提交模型 API Key 或可执行资源

本例的 `clock` Agent 只配一个只读时间工具，避免把服务端装配和复杂工具流程混在一起。固定工作区无需位置回调，详细配置见 [Elmino 应用实例](elmino.md)

## 启动与调试

在仓库根目录执行：

```sh
pnpm example:server
```

命令先构建所需框架包，再启动 `@example/server`。也可以在依赖已经构建后，进入 `examples/tutorial/03-server` 执行 `pnpm start`

默认监听 [http://127.0.0.1:3000](http://127.0.0.1:3000)。服务会持续运行；打开 [API 文档](http://127.0.0.1:3000/api/docs) 查看接口用途、字段说明、示例和运行控制语义。机器可读的 OpenAPI 定义位于 `/api/spec.json`，SDK 使用 `/rpc`

配置了 `ELMINO_SERVER_KEY` 时，在 Scalar 的 Bearer 认证中填写该值；未配置时直接调用。文档地址本身不需要访问凭据，只包含静态接口定义

```sh
# 未配置访问 Key 时，直接检查服务状态
curl http://127.0.0.1:3000/api/health

# 配置了访问 Key 时，携带自己的开发凭据
curl -H 'Authorization: Bearer <ELMINO_SERVER_KEY>' \
  http://127.0.0.1:3000/api/health
```

健康检查成功返回 `{"status":"ok"}`，不会采样模型。需要通过远程任务验证工具执行、思考与回复时，保持这个终端运行，继续 [SDK 教程](sdk-example.md)

## 扩展 HTTP 接口

需要加入自己的路由或中间件时，在 `defineServer` 中使用可选的 `http(app)`：

```ts
const server = defineServer({
  elmino,
  http(app) {
    app.get('/host/info', context => context.json({ name: 'clock-service' }))
  },
})
```

`app` 是真实 Hono 实例，回调在定义时同步注册接口。自定义接口的鉴权由宿主负责；框架 API 仍使用 Server 的凭据与授权规则。详细中间件、CORS、文档配置见 [Server 指南](server-sdk.md#扩展-hono)

## 持久化与退出

Elmino 在首次需要工作区时打开 SQLite 与本地文件内容存储，运行记录默认保存在 `examples/tutorial/03-server/.elmino`。保持同一数据目录即可在重启后读取既有线程；运行数据不加入 Git

在 Server 终端按 `Ctrl+C`，示例宿主同时关闭 Server 与 Elmino，并等待资源释放：

```ts
await Promise.allSettled([server.close(), elmino.close()])
```

源码中的退出处理还会逐项报告清理错误。`server.close()` 关闭 HTTP 接入与它的订阅；`elmino.close()` 结算执行并释放存储配置租约。关闭某个 Server 本身不会终止共享 Elmino，因而本例显式关闭两者。`shutdownSignals: false` 让示例宿主统一处理退出，避免把应用资源清理交给单个接入实例

## 源码导航

| 想了解什么 | 文件 |
| --- | --- |
| 启动与入口错误处理 | [src/index.ts](../examples/tutorial/03-server/src/index.ts) |
| 应用装配、常驻服务与关闭 | [app/run.ts](../examples/tutorial/03-server/src/app/run.ts) |
| Agent 提示词、工具与 Runtime 装配 | [agent/clock.ts](../examples/tutorial/03-server/src/agent/clock.ts) |
| 真实 DeepSeek 适配器与冻结快照恢复 | [model/deepseek.ts](../examples/tutorial/03-server/src/model/deepseek.ts) |
| Runtime 与本地执行环境 | [runtime/runtime.ts](../examples/tutorial/03-server/src/runtime/runtime.ts) |
| 只读服务端时间工具 | [tool/current-time.ts](../examples/tutorial/03-server/src/tool/current-time.ts) |

服务端测试使用确定性模型验证真实 HTTP、工具执行与持久化；不读取 `.env`，不调用外部模型。远程订阅与重连的学习流程见独立 [SDK 教程](sdk-example.md)
