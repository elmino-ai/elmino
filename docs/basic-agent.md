# 01 · Basic Agent 示例

[01-basic-agent](../examples/01-basic-agent) 只演示一个功能：真实 DeepSeek 模型调用 `write_note`，在新建的临时工作区写入 `result.txt` 并返回完成说明。它是使用 elmino 公开包的私有应用，不增加框架发布包

从仓库根目录启动：

```sh
pnpm example:01-basic-agent
```

启动入口是 [src/index.ts](../examples/01-basic-agent/src/index.ts)，只负责启动与错误处理，其他实现按职责放在子目录

| 目录 | 职责 |
| --- | --- |
| [src/agent](../examples/01-basic-agent/src/agent) | 组合 Agent、模型、运行环境和 Store，提交任务并关闭资源 |
| `src/model` | 直接装配 DeepSeek 的 Anthropic Messages 适配器，本地凭据不进入运行快照 |
| [src/runtime](../examples/01-basic-agent/src/runtime) | 为线程创建真实 LocalSandbox，冻结当前启动环境 |
| [src/tool](../examples/01-basic-agent/src/tool) | 定义写入当前工作区 `result.txt` 的工具 |
| [src/storage](../examples/01-basic-agent/src/storage) | 装配 SqliteStore 与文件 BlobStore，宿主决定数据目录 |

模型与接口地址直接配置在 `src/model/deepseek.ts`，运行前将 `YOUR_DEEPSEEK_API_KEY` 替换为本机密钥。真实密钥只保留为本地未提交改动，提交前必须恢复占位值；模型元信息与适配器凭据分开装配，密钥不写入 SQLite

每次启动使用独立临时目录，输出 Agent 回复、实际文件内容与数据目录。演示使用 `fullAccess` 执行固定文件写入，有 60 秒执行期限；它不提供多模型切换、命令参数、人机审批或恢复 CLI

Engine 负责释放线程 Runtime，宿主在 Engine 关闭后关闭 Store。数据目录中的 `database/`、`blobs/` 和 `workspace/` 保留供检查，示例不自动清理，也不读取产品配置或用户认证目录

类型检查可从根目录执行，Turbo 会先构建实际依赖：

```sh
pnpm exec turbo run typecheck --filter=@example/01-basic-agent
```

工具审批、中断、恢复和子智能体等能力仍由所属框架包的测试与交付验收覆盖。旧宿主的接入差异见 [接入清单](integration.md)，工程命令与发布边界见 [开发指南](contributing.md)
