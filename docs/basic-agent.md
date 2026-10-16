# Basic Agent：简单用法与完整配置

入口选择与扩展能力见 [Agent 使用指南](agent.md)。两个示例都使用真实 DeepSeek 模型调用 `write_note`，在独立临时工作区写入 `result.txt`。它们是两个可单独运行的私有 workspace，通过 `@elmino/*` 公开入口使用框架

| 示例 | 学习内容 | 运行入口 |
| --- | --- | --- |
| [01-basic-agent](../examples/tutorial/01-basic-agent) | 只传 5 个必填参数，等待完成后打印回复 | [app/run.ts](../examples/tutorial/01-basic-agent/src/app/run.ts) |
| [02-full-agent](../examples/tutorial/02-full-agent) | 显式配置执行模式、超时、事件输出，检查结果并展示持久化身份和文件内容 | [app/run.ts](../examples/tutorial/02-full-agent/src/app/run.ts) |

## 简单用法

先在第一个示例自己的 `.env` 中配置 `DEEPSEEK_API_KEY`：

```sh
cp examples/tutorial/01-basic-agent/.env.example examples/tutorial/01-basic-agent/.env
pnpm example:basic-agent
```

填写密钥后运行。核心调用只包含 `agent`、`model`、`store`、`workspace` 和 `input`：

```ts
const result = await runAgent({
  agent: writer,
  model: createModel(),
  store: sqliteStore({ dataDir }),
  workspace: { id: 'example', rootDir },
  input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
})
```

简单版只在执行结束后输出回复与数据目录，不订阅实时事件，也不设置整次任务的执行期限。默认 `approvalMode` 是 `fullAccess`，`subagentMode` 是 `explicitOnly`；本例只在新建临时工作区执行固定写入

## 完整配置

完整版独立使用自己的 `.env`：

```sh
cp examples/tutorial/02-full-agent/.env.example examples/tutorial/02-full-agent/.env
pnpm example:full-agent
```

填写密钥后运行。它在相同任务上展示所有可选运行参数：

```ts
const result = await runAgent({
  agent: writer,
  model,
  store: sqliteStore({ dataDir }),
  workspace: { id: 'example', rootDir },
  input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
  approvalMode: 'fullAccess',
  subagentMode: 'explicitOnly',
  signal: AbortSignal.timeout(60_000),
  onRuntimeEvent: createTerminalOutput(),
})
```

`approvalMode` 和 `subagentMode` 显式展示默认值；该示例不发起子智能体任务。`signal` 设置 60 秒期限，`onRuntimeEvent` 增量打印模型返回的可见思考与回复。结束后检查 `result.status`，输出线程 ID、Turn ID、实际文件内容与数据目录。执行失败或审批等待不会被当作完成；入口异常、取消和资源关闭错误由启动入口报告并设置失败退出码

返回值保留持久化身份、状态、可选助手消息和失败原因 `errorMessage`。每次 `runAgent` 都是新线程，多轮会话与审批恢复使用 `AgentEngine`；可继续查看 [AgentEngine 高级参考](agent-engine.md)，这两个基础示例保持单次调用

## 目录和环境

两个示例均保留 `src/index.ts` 作为启动与错误处理入口；`agent` 定义行为，`app` 发起任务，`model` 装配模型，`runtime` 创建 LocalSandbox，`tool` 定义写文件工具。完整版额外包含 [terminal/terminal.ts](../examples/tutorial/02-full-agent/src/terminal/terminal.ts) 处理增量事件。每个示例都包含自身所需代码，不从另一个示例导入实现

每个示例通过 `--env-file-if-exists=.env` 加载自己的环境变量，不读取其他示例或仓库根的 `.env`。同名终端环境变量优先，`DEEPSEEK_MODEL` 与 `DEEPSEEK_BASE_URL` 可覆盖默认值，配置项见各自 `.env.example`。真实 `.env` 由 Git 忽略，凭据不写入 SQLite

`sqliteStore({ dataDir })` 默认配置 SQLite 与本地文件内容存储，调用结束后自动释放。数据目录内的 `database/`、`blobs/` 和 `workspace/` 保留供检查，每次启动创建新的临时目录

类型检查从仓库根执行，Turbo 会先构建实际依赖：

```sh
pnpm exec turbo run typecheck --filter=@example/basic-agent --filter=@example/full-agent
```

应用内复用 Agent、模型与工作区时，先阅读 [Elmino 教程](elmino-example.md)；远程调用继续阅读 [Server 教程](server-example.md) 与 [SDK 教程](sdk-example.md)，旧宿主接入见 [接入清单](integration.md)，工程命令见 [开发指南](contributing.md)
