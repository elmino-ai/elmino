# 02 · Server 与 SDK

第二个示例展示一件事：通过 SDK 远程调用 Agent。一个进程先打开本机 HTTP 端口，再用独立 SDK 客户端通过真实 HTTP / SSE 连接，提交任务、接收思考与工具事件，最后查询 SQLite 保存的线程结果

## 运行

在仓库根目录执行：

```sh
cp examples/02-server-sdk/.env.example examples/02-server-sdk/.env
```

在新建的 `.env` 中填写 `DEEPSEEK_API_KEY`。该文件只属于这个示例，已被 Git 忽略；仓库不会从其他示例复制密钥

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
SERVER_KEY=
```

`SERVER_KEY` 留空时，示例为本次运行生成临时访问凭据，在 Server 与 SDK 之间共享且不打印。需要自行连接时，可以填写自己的值。模型采用真实 DeepSeek，通过 Anthropic Messages 接口调用，没有默认的模拟模型分支

```sh
pnpm example:02-server-sdk
```

示例会：

1. 创建独立临时工作区、SQLite 和文件 BlobStore
2. 启动只提供 `current_time` 工具的 Agent Server，监听 `127.0.0.1` 随机端口
3. SDK 先建立事件订阅，再提交读取服务端时间的任务
4. 打印模型提供的可见思考、工具结果和回复
5. 查询持久化线程并打印 Turn 状态，随后关闭订阅、Server、HTTP 连接和 Store

输出结构如下，模型正文与时间以实际返回为准：

```text
Server 地址： http://127.0.0.1:…
思考：
…模型返回的可见思考…
工具 current_time：…UTC 时间…
回复：
…模型的完成说明…
持久化 Turn 状态： completed
示例数据目录： …/elmino-server-sdk-…
```

模型未提供可见思考时，不会生成替代文本。本例在完整片段完成后打印一次，SDK 本身也支持逐条接收正文、思考和工具输出增量

运行设置 60 秒期限。每次启动都会创建新的临时目录；退出后保留目录，便于检查 SQLite 和 BlobStore。示例不覆盖已有项目文件，也不使用真实用户工作区

## 源码导航

| 职责 | 文件 |
| --- | --- |
| 启动和入口错误处理 | [src/index.ts](../examples/02-server-sdk/src/index.ts) |
| 打开端口与资源关闭顺序 | [app/run.ts](../examples/02-server-sdk/src/app/run.ts) |
| Agent、工作区、模型与鉴权注入 | [server/create.ts](../examples/02-server-sdk/src/server/create.ts) |
| SDK 订阅、提交、重建与结果查询 | [client/run.ts](../examples/02-server-sdk/src/client/run.ts) |
| 真实 DeepSeek 适配器 | [model/deepseek.ts](../examples/02-server-sdk/src/model/deepseek.ts) |
| SQLite 与文件内容存储 | [storage/storage.ts](../examples/02-server-sdk/src/storage/storage.ts) |
| Runtime 与本地执行环境 | [runtime/runtime.ts](../examples/02-server-sdk/src/runtime/runtime.ts) |
| 只读时间工具 | [tool/current-time.ts](../examples/02-server-sdk/src/tool/current-time.ts) |

`onReset` 在回放不能续接时重新读取权威线程。普通断网由 SDK 自动重连；取消订阅不会取消已经接纳的任务。需要中断任务时使用 `client.rpc.turn.interrupt()`

更多配置、所有权与审批恢复接口见 [Server 与 SDK 指南](server-sdk.md)。仓库的确定性测试使用测试模型覆盖相同 HTTP 流程、断网回放与 Server 重建恢复，不依赖 API Key 或外部模型服务
