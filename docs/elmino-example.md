# 03 · Elmino

第三个教程学习用 `defineElmino()` 创建本地应用实例：一次注册 Agent、模型和工作区，在同一线程运行两轮，查询保存的结果，最后关闭资源。它承接 [Basic 与 Full Agent](basic-agent.md)，下一篇 [04 · Server](server-example.md) 再为应用实例增加 HTTP 接入

## 学习目标与运行结果

`runAgent()` 适合完成一次独立任务。应用需要多次调用相同 Agent、复用模型注册和工作区资源时，可以把这些配置放进一个 Elmino 实例，再调用 `elmino.run()`

本例注册 `clock` Agent 和真实 DeepSeek 模型。第一轮调用 `current_time` 读取 UTC 时间；第二轮传回第一轮的 `threadId`，要求基于已有上下文总结。结束后读取线程，展示模型返回的可见思考、正文、工具结果和已完成轮数

示例位于 `examples/tutorial/03-elmino`，私有工作区包名为 `@example/elmino`。它直接在 Node.js 进程中执行，不需要先启动 Server

## 配置与启动

在仓库根目录执行：

```sh
cp examples/tutorial/03-elmino/.env.example examples/tutorial/03-elmino/.env
```

填写自己的模型凭据：

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
ELMINO_DATA_DIR=
```

| 配置 | 用途与默认值 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 模型凭据，必填 |
| `DEEPSEEK_MODEL` | 模型名称，默认 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | Anthropic Messages 兼容地址，默认 `https://api.deepseek.com/anthropic` |
| `ELMINO_DATA_DIR` | 可选运行数据目录，留空使用本例目录下的 `.elmino` |

模型工厂读取 `DEEPSEEK_*`，`sqliteStore()` 读取 `ELMINO_DATA_DIR`。本例的启动命令加载自己的 `.env`，无需在入口逐层传递环境值。真实 `.env` 与运行数据均被 Git 忽略

```sh
pnpm example:elmino
```

命令先构建依赖，再执行示例。已构建依赖时，也可以进入 `examples/tutorial/03-elmino` 执行 `pnpm start`。两轮任务和线程查询完成后，进程退出；输出中的时间、回复和思考以实际模型返回为准

## 先定义应用实例

从 [app/elmino.ts](../examples/tutorial/03-elmino/src/app/elmino.ts) 开始阅读。核心配置如下，`clock`、`createModel` 和 `workspaceRoot` 由示例模块提供：

```ts
import { defineElmino } from '@elmino/core'
import { sqliteStore } from '@elmino/store-sqlite'

const elmino = defineElmino({
  agents: { clock },
  models: {
    deepseek: ({ frozenConfig }) => createModel(frozenConfig),
  },
  workspace: {
    id: 'example',
    rootDir: workspaceRoot,
    store: sqliteStore(),
  },
})
```

`clock` 是 `defineAgent()` 返回的行为定义，描述提示词、工具和 Runtime。`defineElmino()` 把定义与模型、工作区组合起来，管理共享 Engine 与存储配置租约。定义阶段不会调用模型或打开数据库；首次执行时才取得工作区资源

这里只有一个注册模型，因此无需再写 `defaults.model`。注册键 `deepseek` 与模型的可持久化 `config.id` 一致；厂商模型名称由 `DEEPSEEK_MODEL` 决定。凭据留在适配器中，恢复原 Turn 时模型工厂使用 `frozenConfig` 重建原配置

固定工作区已经声明了 `id` 和 `rootDir`，后续 `run()` 可以省略 `workspaceId`。运行记录保存在 SQLite 与本地内容存储中，项目目录则由宿主准备并交给 Runtime 使用

## 再运行同线程两轮

主流程位于 [app/run.ts](../examples/tutorial/03-elmino/src/app/run.ts)。第一轮不提供线程或 Turn 身份，由实例自动生成：

```ts
const first = await elmino.run({
  agentId: 'clock',
  input: '请调用 current_time 读取当前 UTC 时间，并用中文简短说明',
  signal: AbortSignal.timeout(60_000),
})
```

`await elmino.run()` 会等待本轮执行结束，返回线程、Turn、工作区身份，以及已持久化的 `status`、可选助手消息与失败原因。主流程检查 `status === 'completed'` 后才进入下一轮；入口异常、取消和清理错误也可能抛出，不能只检查返回状态

第二轮复用同一线程，继续读取前一轮上下文：

```ts
const second = await elmino.run({
  agentId: 'clock',
  threadId: first.threadId,
  input: '沿用上一轮读取的时间，用一句话总结，不要再次调用工具',
  signal: AbortSignal.timeout(60_000),
})
```

传入 `threadId` 表示继续同一会话；省略 `turnId` 会为第二轮生成新的执行身份。两个调用复用同一应用实例和工作区资源。这里每轮分别设定等待期限，超时通过本轮 `signal` 取消执行

## 读取线程并关闭实例

第二轮完成后，使用结果携带的身份读取线程：

```ts
const state = await elmino.getThread({
  agentId: 'clock',
  workspaceId: second.workspaceId,
  threadId: second.threadId,
})
```

`getThread()` 返回消息、工具结果和 Turn 状态等线程数据。示例从这份结果展示两轮助手输出，并统计已完成轮数。可见思考只有模型实际提供时才显示，不会生成替代内容

创建实例的应用负责在结束时关闭它，示例将关闭放在 `finally` 中：

```ts
try {
  // 两轮 run() 与 getThread()
}
finally {
  await elmino.close()
}
```

一次 `run()` 结束不会释放实例持有的工作区存储租约，后续任务可以继续复用。`elmino.close()` 会结算执行、结束观察并释放配置租约；关闭后再次使用需要重新创建实例。持久化记录仍保留，下次以相同数据目录创建实例可以查询历史

## 源码导航

| 想了解什么 | 文件 |
| --- | --- |
| 启动与入口错误处理 | [src/index.ts](../examples/tutorial/03-elmino/src/index.ts) |
| 两轮调用、结果查询与关闭 | [app/run.ts](../examples/tutorial/03-elmino/src/app/run.ts) |
| 注册表、固定工作区与存储配置 | [app/elmino.ts](../examples/tutorial/03-elmino/src/app/elmino.ts) |
| Agent 提示词、工具与 Runtime | [agent/clock.ts](../examples/tutorial/03-elmino/src/agent/clock.ts) |
| 真实模型工厂与冻结配置 | [model/deepseek.ts](../examples/tutorial/03-elmino/src/model/deepseek.ts) |
| 本地执行环境 | [runtime/runtime.ts](../examples/tutorial/03-elmino/src/runtime/runtime.ts) |
| 只读 UTC 时间工具 | [tool/current-time.ts](../examples/tutorial/03-elmino/src/tool/current-time.ts) |

模型选择、动态工作区与完整所有权规则见 [Elmino 应用实例指南](elmino.md)。接下来学习 [04 · Server](server-example.md)：把 Elmino 传给 `defineServer()`，增加常驻 HTTP 服务；再学习 [05 · SDK](sdk-example.md) 连接它
