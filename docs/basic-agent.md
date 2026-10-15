# Basic Agent 示例

[示例源码](../examples/basic-agent) 是一个私有消费项目，通过 `@elmino/*` 公开入口装配 Agent，不增加框架发布包。运行示例需要仓库固定的 Node.js 24、pnpm 11 和已安装的工作区依赖，命令从仓库根目录执行

默认使用可重复运行的离线演示模型，真实使用 Engine、默认 Loop、工具审批、LocalSandbox 文件写入、SQLite 和文件 BlobStore。演示模型只会请求 `write_note`，得到工具结果后结束；这条流程用于理解装配和恢复，不代表真实模型的推理效果

## 运行与审批恢复

先选择一个专用临时目录，三次命令使用同一个目录。每条命令结束都会关闭当前进程的 Engine 与 Store

```sh
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/elmino-basic-agent.XXXXXX")"

pnpm example:basic-agent start --data-dir "$DEMO_DIR"
pnpm example:basic-agent inspect --data-dir "$DEMO_DIR"
pnpm example:basic-agent resume --data-dir "$DEMO_DIR" --approve
pnpm example:basic-agent inspect --data-dir "$DEMO_DIR"
```

`start` 输出 `status: interrupted`，以及待批准的 `write_note` 参数。此时 `file` 和 `artifact` 都为空；`inspect` 只读取已保存的状态，不调用模型或批准工具

`resume --approve` 从数据库读取原 Turn 的冻结模型配置与待决中断，使用原 Thread、Turn 和 Provider call ID 提交审批响应。成功后输出 `status: completed`，`file` 和二进制 `artifact.content` 都为 `Hello from elmino`。重新运行 `inspect` 会从数据库和文件重新读取这些结果

也可以在另一个新目录运行 `start` 后拒绝审批：

```sh
REJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/elmino-basic-agent-reject.XXXXXX")"
pnpm example:basic-agent start --data-dir "$REJECT_DIR"
pnpm example:basic-agent resume --data-dir "$REJECT_DIR" --reject
```

拒绝后工具记录为 `skipped`，不会写出文件或产物。已经结束的 Turn 不能再次 `resume`；同一示例目录不能重复 `start`，新的会话使用新的专用目录

示例主动暂停在工具审批处，验证的是正常退出后的持久恢复。它没有模拟执行到一半被强制终止，也不覆盖排队子智能体的重启恢复；这些生命周期继续由 Engine 的能力测试覆盖

## 源码入口与所有权

| 文件 | 职责 |
| --- | --- |
| [cli/cli.ts](../examples/basic-agent/src/cli/cli.ts) | 解析命令、接纳运行、读取原中断并提交审批决策 |
| [host/host.ts](../examples/basic-agent/src/host/host.ts) | 装配工具、真实 Sandbox、共享 Store、BlobStore 和 Engine，读取持久化结果 |
| [model/model.ts](../examples/basic-agent/src/model/model.ts) | 离线 Provider 与真实模型适配器的装配、冻结配置恢复和凭据读取 |
| [session/session.ts](../examples/basic-agent/src/session/session.ts) | 宿主持有会话定位信息，拒绝覆盖已有会话 |

宿主目录包含 `session.json`、`database/`、`blobs/` 与 `workspace/`。会话文件仅保存定位 ID，模型配置由 RuntimeStore 持久化；真实模型凭据只进入适配器。示例不会读取产品模型目录、control.db、登录 Shell 初始化文件或用户认证文件，也不自动清理传入的数据目录

工具通过 Runtime 的 Sandbox 写入 `workspace/result.txt`。二进制产物由独立的文件 BlobStore 保存，SQLite 持有其内容引用；二者可分别替换。数据库事务不能撤销已经完成的外部文件或 blob 写入

Engine 拥有线程 Runtime 的释放权，宿主拥有 Store 的关闭权。示例先等待 `engine.close()`，再关闭 Store；每次进程重新装配都复用同一数据目录和 BlobStore 策略

示例复制当前启动环境并通过 `LocalEnv` 冻结。实际应用需要登录 Shell 环境时，可在自己的宿主边界使用 `loadUserEnv`；产品目录、Shell 偏好和启动变量来源继续由宿主决定

## 使用真实模型

真实模式使用 `@elmino/llm-openai/responses` 的 `ResponsesProvider`。参考 [环境变量模板](../examples/basic-agent/.env.example)，在运行命令的终端设置以下变量；示例不自动读取 `.env`

```sh
export ELMINO_EXAMPLE_MODEL='你的模型名称'
export ELMINO_EXAMPLE_API_KEY='你的 API Key'
export ELMINO_EXAMPLE_BASE_URL='https://api.openai.com/v1'

REAL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/elmino-basic-agent-openai.XXXXXX")"
pnpm example:basic-agent start --provider openai --data-dir "$REAL_DIR"
```

真实模式也需要一个尚未创建会话的专用目录。模型必须支持 Responses 协议和工具调用；兼容服务通过 `ELMINO_EXAMPLE_BASE_URL` 指定。真实模型的工具选择和输出具有不确定性，以命令返回的 `pending` 与 `status` 为准

恢复时继续提供 `ELMINO_EXAMPLE_API_KEY`，使用普通的 `resume --approve` 或 `resume --reject`。模型名称和接口地址沿用原 Turn 的冻结配置，不受当前 `ELMINO_EXAMPLE_MODEL`、`ELMINO_EXAMPLE_BASE_URL` 改动影响。示例不把 API Key 写入模型配置，也不打印环境变量

## 验证与接入范围

```sh
pnpm exec turbo run build --filter=@example/basic-agent...
pnpm --filter @example/basic-agent typecheck
pnpm --filter @example/basic-agent test
```

生命周期测试使用独立子进程覆盖批准、拒绝、重开读取、重复开始和重复恢复。模型测试检查离线事件、取消、冻结配置与凭据边界，不请求真实模型服务

这份示例不引用内部测试夹具，也不从其他包的 `src` 导入生产实现。正式 npm 包尚未发布；在仓库外验证时需要先打包，再把示例依赖指向同批 tarball。复制到新项目时应为消费项目声明实际使用的包和开发依赖

旧宿主的模型工厂、插件装配、共享 Store、Workspace 所有权、Thread/SSE 和长期数据保留差异见 [接入清单](integration.md)。示例验证通用装配，旧宿主尚未接入 elmino
