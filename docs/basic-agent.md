# 01 · Basic Agent 示例

[01-basic-agent](../examples/01-basic-agent) 只演示一个功能：真实 DeepSeek 模型调用 `write_note`，在新建的临时工作区写入 `result.txt` 并返回完成说明。它是使用 elmino 公开包的私有应用，不增加框架发布包

首次使用先从仓库根目录复制环境变量模板，并在示例自己的 `.env` 中填写 `DEEPSEEK_API_KEY`：

```sh
cp examples/01-basic-agent/.env.example examples/01-basic-agent/.env
```

然后从仓库根目录启动：

```sh
pnpm example:01-basic-agent
```

启动入口是 [src/index.ts](../examples/01-basic-agent/src/index.ts)，只负责启动与错误处理，其他实现按职责放在子目录

| 目录 | 职责 |
| --- | --- |
| [src/agent](../examples/01-basic-agent/src/agent) | 仅定义 Agent 的系统提示词、工具与运行环境 |
| [src/app](../examples/01-basic-agent/src/app) | 准备临时目录、模型和 Store，通过 runAgent 提交任务并展示结果 |
| `src/model` | 直接装配 DeepSeek 的 Anthropic Messages 适配器，本地凭据不进入运行快照 |
| [src/terminal](../examples/01-basic-agent/src/terminal) | 订阅运行事件，增量打印模型返回的思考与回复 |
| [src/runtime](../examples/01-basic-agent/src/runtime) | 为线程创建真实 LocalSandbox，冻结当前启动环境 |
| [src/tool](../examples/01-basic-agent/src/tool) | 定义写入当前工作区 `result.txt` 的工具 |
| [src/storage](../examples/01-basic-agent/src/storage) | 装配 SqliteStore 与文件 BlobStore，宿主决定数据目录 |

Agent 定义见 [agent/agent.ts](../examples/01-basic-agent/src/agent/agent.ts)，文件只包含 `defineAgent()` 配置。单次执行见 [app/run.ts](../examples/01-basic-agent/src/app/run.ts)：

```ts
const result = await runAgent({
  agent: writer,
  model,
  store,
  workspace: { id: 'example', rootDir },
  input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
  approvalMode: 'fullAccess',
  signal: AbortSignal.timeout(60_000),
  onRuntimeEvent: createTerminalOutput(),
})
```

`runAgent` 来自 `@elmino/engine`，自动生成新线程与 Turn 身份并计算项目执行位置。调用等待本次执行结算、释放 Engine 后才结束，Store 仍由示例关闭；返回值保留持久化身份、状态与助手消息。检查 `result.status` 区分完成、执行失败和审批等待，失败原因在 `result.errorMessage`；入口异常、取消与关闭错误会抛出。每次调用都是新线程，多轮会话与恢复使用 `AgentEngine`

每个示例独立维护 `.env`，启动命令通过 Node.js 的 `--env-file-if-exists=.env` 加载当前示例目录中的配置，不读取仓库根或其他示例的 `.env`。文件不存在时仍可使用终端注入的环境变量，同名终端环境变量优先于文件中的值。`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL` 可覆盖默认模型与接口地址，具体变量见 [.env.example](../examples/01-basic-agent/.env.example)

真实 `.env` 由根 `.gitignore` 排除，仓库只提交 `.env.example`。模型元信息与适配器凭据分开装配，密钥不写入 SQLite

每次启动使用独立临时目录，实时打印模型返回的思考与回复，完成后输出实际文件内容与数据目录。思考模式按 [DeepSeek 官方参数](https://api-docs.deepseek.com/guides/thinking_mode/) 显式开启，仅展示服务端实际返回的可见内容。演示使用 `fullAccess` 执行固定文件写入，有 60 秒执行期限；它不提供多模型切换、命令参数、人机审批或恢复 CLI

Engine 负责释放线程 Runtime，宿主在 Engine 关闭后关闭 Store。数据目录中的 `database/`、`blobs/` 和 `workspace/` 保留供检查，示例不自动清理，也不读取产品配置或用户认证目录

类型检查可从根目录执行，Turbo 会先构建实际依赖：

```sh
pnpm exec turbo run typecheck --filter=@example/01-basic-agent
```

工具审批、中断、恢复和子智能体等能力仍由所属框架包的测试与交付验收覆盖。旧宿主的接入差异见 [接入清单](integration.md)，工程命令与发布边界见 [开发指南](contributing.md)
