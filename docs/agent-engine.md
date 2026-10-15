# 高级参考：直接使用 AgentEngine

[agent-engine](../examples/reference/agent-engine) 面向需要自己管理线程、Turn 和引擎生命周期的宿主。Tutorial 中的 Basic 和 Full 使用 `runAgent()`，每次调用新建线程并释放 Engine；这里显式保留引擎和 Store，演示同一线程多轮对话，以及重建引擎后的审批恢复

## 运行

在示例自己的 `.env` 中填写 `DEEPSEEK_API_KEY`，其他模型参数见 [.env.example](../examples/reference/agent-engine/.env.example)：

```sh
cp examples/reference/agent-engine/.env.example examples/reference/agent-engine/.env
# 填写密钥后启动
pnpm example:agent-engine
```

终端先显示运行数据目录，然后执行以下流程：

1. 第一轮记住 `Hello from elmino`，仅回复确认
2. 第二轮沿用同一个线程，要求把上轮内容写入 `result.txt`
3. 工具采用 `approval: 'auto'`，Turn 使用 `approvalMode: 'request'`，写文件前进入待审批状态
4. 示例关闭原 Engine 并创建新 Engine，通过 `recoverWorkspace()` 恢复工作区，再从 Store 读取原 Turn 的中断信息
5. 终端展示待审批工具及参数；输入 `y` 才恢复并执行，其他输入保留待审批记录后退出
6. 完成后打印线程、两轮 Turn 的 ID 和文件内容，先关闭 Engine，再释放 Store 租约

整次示例有两分钟期限，包含等待确认的时间。只展示模型实际返回的可见思考和回复。运行数据保留在独立临时目录，不自动清理

## API 导航

| API / 字段 | 参考内容 |
| --- | --- |
| `AgentEngine.create()` | 宿主显式创建和持有 Engine |
| `engine.run()` | 同一个线程发起新 Turn，复用既有历史 |
| `accepted` / `completed` | 分别等待接纳和执行结算 |
| `engine.recoverWorkspace()` | 新 Engine 从持久化事实恢复工作区 |
| `engine.resume()` | 使用原线程、Turn 和中断身份提交审批结果 |
| `engine.close()` / `lease.release()` | 按所有权先关闭引擎，再释放存储 |

## 核心调用

存储配置在高级入口由宿主显式借用，再把 `RuntimeStore` 传给 Engine：

```ts
const lease = await sqliteStore({ dataDir })()
const engine = AgentEngine.create({ writer })

const execution = engine.run({
  agentId: writer.id,
  threadId,
  turnId,
  model,
  location,
  input: [{ type: 'text', text: '请记住本次便签内容' }],
  approvalMode: 'request',
}, lease.store)

await execution.accepted
await execution.completed
```

`accepted` 表示任务已接纳并持久化，不代表模型或工具已完成。需要继续同一线程时保留 `threadId`，生成新的 `turnId`；同一线程的上一轮执行结算后，再发起下一轮

审批恢复使用 `engine.resume()`，保留原来的 `threadId`、`turnId` 和当前 `interruptId`，提交与待审动作 `callId` 匹配的决策。模型按该 Turn 持久化的 `modelConfig` 重建并重新注入当前凭据，不能换成当前默认模型配置

完整调用和失败清理见 [engine/run.ts](../examples/reference/agent-engine/src/engine/run.ts)。`completed` 完成后仍需检查持久化状态：审批暂停属于 `interrupted`，模型执行失败可结算为 `failed`；入口或取消错误可能直接拒绝 Promise

## 生命周期与边界

同一 Store 在本次示例的两个 Engine 之间持续保持打开。示例模拟的是**同一进程内重建 Engine**，从持久化事实恢复审批；它没有提供跨进程的命令行续接入口，也不自动恢复上次退出留下的临时目录

Engine 负责线程 Runtime，宿主负责 Store 租约。清理时先等待 `engine.close()` 完成，再调用 `lease.release()`；即使执行或某项关闭失败，也继续释放其他资源并保留错误。不要直接关闭借用租约中的共享 `store`

未批准时不会执行工具，第二轮保持待审批状态。这里的“暂不批准”没有向模型提交拒绝决策；真实应用可通过审批响应实现拒绝、修改参数等操作

| 源码 | 职责 |
| --- | --- |
| [src/index.ts](../examples/reference/agent-engine/src/index.ts) | 启动与入口错误处理 |
| [app/run.ts](../examples/reference/agent-engine/src/app/run.ts) | 模型、临时目录、超时、终端交互与结果展示 |
| [engine/run.ts](../examples/reference/agent-engine/src/engine/run.ts) | 引擎装配、两轮任务、重建、审批恢复和清理 |
| [agent/agent.ts](../examples/reference/agent-engine/src/agent/agent.ts) | Agent 行为定义 |
| [tool/write-note.ts](../examples/reference/agent-engine/src/tool/write-note.ts) | 需要审批的写文件工具 |
| [terminal/approval.ts](../examples/reference/agent-engine/src/terminal/approval.ts) | 展示待审调用并获取确认 |
| [tests/engine.test.ts](../examples/reference/agent-engine/tests/engine.test.ts) | 用确定性模型验证历史、审批恢复、文件与持久化，不调用真实模型 |

类型检查与测试从根目录运行：

```sh
pnpm exec turbo run typecheck test --filter=@example/agent-engine
```

从简单用法开始见 [Basic Agent](basic-agent.md)，远程接入见 [Server / SDK](server-sdk.md)，旧宿主迁入差异见 [接入清单](integration.md)
