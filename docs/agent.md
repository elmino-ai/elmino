# Agent 使用指南

`defineAgent()` 定义行为，运行入口管理模型、存储、任务身份与资源生命周期。先根据需要选择入口：

| 需要做什么 | 入口 | 可运行示例 |
| --- | --- | --- |
| 完成一次任务 | `runAgent()` | [Basic Agent](../examples/tutorial/01-basic-agent) |
| 配置实时输出、超时和执行模式 | `runAgent()` 可选参数 | [Full Agent](../examples/tutorial/02-full-agent) |
| 通过 HTTP / SDK 调用 | `defineServer()` / `Client.create()` | [Server / SDK](../examples/tutorial/03-server-sdk) |
| 保留线程并管理多轮、审批恢复 | `AgentEngine` | [引擎参考](../examples/reference/agent-engine) |
| 注入上下文、改写工具参数与释放 Turn 资源 | `AgentHooks` | [Hooks 参考](../examples/reference/agent-hooks) |
| 向运行中的任务补充要求或中断它 | `engine.steer()` / `engine.interrupt()` | [运行控制参考](../examples/reference/turn-control) |
| 显式委派子任务并等待结果 | 工具中的 `subagentHostService` | [子智能体参考](../examples/reference/subagents) |

Tutorial 按顺序学习，Reference 按能力查阅。第三方框架、平台或服务的接入示例归 `integration`，不把框架自身的 API 用法放入该分类

## 定义行为

```ts
import { defineAgent } from '@elmino/agent'

const writer = defineAgent({
  id: 'writer',
  systemPrompt: '按用户要求调用工具完成任务',
  runtime,
  tools,
})
```

必填项是 `id`、`systemPrompt` 和 `runtime`。`tools` 可以省略；`name` 默认使用 `id`，`description` 默认是空字符串。`loop` 与 `thread` 分别默认使用框架 Loop 和 Thread 投影，需要替换时再显式提供

`defineAgent()` 只装配定义，不会打开数据库或创建 Sandbox。定义和工具、Hooks 的选择会被冻结，执行中不要通过修改原配置切换行为；需要另一种行为时创建新的 Agent 定义

## 定义工具

```ts
import { defineTools } from '@elmino/tool'
import { z } from 'zod'

const tools = defineTools({
  write_note: {
    description: '把便签内容写入工作区 result.txt',
    schema: z.object({ text: z.string().min(1) }),
    scope: 'modify',
    async execute({ text }, { sandbox }) {
      const result = await sandbox.files.write('result.txt', text)
      if (result.error)
        throw new Error(result.error)
      return `已写入 ${result.path}`
    },
  },
})
```

工具声明的 `schema` 负责输入校验，`execute` 使用当前 Runtime 提供的 Sandbox。失败可抛出错误，Loop 将工具结果交回模型；一次工具失败不一定意味着整个 Turn 失败，最终结果需要检查 Turn 状态

`approval` 默认是 `never`。需要工具进入审批流程时，显式声明 `approval: 'auto'`，并在执行时设置对应 `approvalMode`。`scope: 'modify'` 描述作用范围，本身不等于“每次必须审批”；`fullAccess` 会跳过普通审批。完整流程见 [引擎参考](agent-engine.md)

## 使用 Hooks

通过 `defineAgent({ hooks })` 注入 `AgentHooks`，不需要插件 SDK。可运行代码见 [agent-hooks](../examples/reference/agent-hooks)，运行命令是 `pnpm example:agent-hooks`

| Hook | 用途 |
| --- | --- |
| `promptStable` | 当前执行切片首次模型请求时读取并冻结的系统上下文 |
| `promptDynamic` | 每次模型请求前重新计算的系统上下文 |
| `promptMessages` | 追加进入 Canonical 历史的提醒消息，不生成用户界面 transcript |
| `processMessages` | 纯转换或过滤模型消息投影，保留原始 `id` 和 `turnId` |
| `onStarted` | 当前 Turn 启动后取得资源，可返回当前 Turn 的清理函数 |
| `initialThread` / `onLifecycle` | 初始化线程元信息、观察固定的执行生命周期载荷 |
| `beforeSnapshot` | 终态快照前收束扩展任务，取消后也要能执行 |
| `beforeTool` / `afterTool` | 工具执行前改写或阻断、成功执行后观察结果 |
| `authorizeTool` | 审批前和参数改写后执行的同步授权策略 |
| `interceptTool` / `projectTool` | 普通审批前接管调用、接管工具消息投影 |
| `collectState` / `resolveInteraction` / `settleState` | 持久化扩展状态、自定义交互恢复与终态收束 |

`beforeTool` 可能读取原始工具参数，应先收窄自己需要的字段。改写后的参数仍经过工具 Schema 和授权检查。Hooks 的放行不能扩大 Sandbox 权限；示例的文本标记规则只是演示策略，不是通用敏感信息检测

`onStarted` 返回的清理函数只属于本次 Turn，不拥有共享 Store 或线程 Runtime 的关闭权。需要长期持有的服务由宿主创建与关闭，不挂在单次执行清理中

## 模型、运行环境与持久化

模型由 `TurnModel` 的 `{ config, adapter }` 组成：`config` 只保存可持久化配置，凭据和 SDK 实例留在适配器。新任务选择当前模型；恢复原 Turn 时按其冻结的 `modelConfig` 重建模型并重新注入凭据

Runtime 定义通过 `runtime.create()` 取得位置，创建当前线程所需 Sandbox；`defineRuntime()` 是本地装配入口。Runtime 负责该线程执行资源的释放，不负责打开数据库。`LocalSandbox` 在本机运行，更强隔离由其他 Sandbox 实现提供

| 存储接入方式 | 创建与释放 |
| --- | --- |
| `runAgent({ store: sqliteStore({ dataDir }) })` | 入口按需借用，Engine 关闭后释放 |
| Server 固定工作区配置 `sqliteStore({ dataDir })` | 首次访问时借用，Server 关闭后释放 |
| 直接传入 `RuntimeStore` 实例 | 由宿主创建与关闭 |
| `const lease = await sqliteStore({ dataDir })()` | 宿主显式借用，Engine 结束后调用 `lease.release()` |

同一数据目录的并发调用应复用同一个 `sqliteStore` 配置对象，最后一个借用者释放时才关闭。`BlobStore` 与 `RuntimeStore` 仍可分别替换；文件写入等外部操作不会随数据库事务回滚

## 状态、事件与后续控制

`runAgent()` 每次创建新线程，适合一次任务。`result.status` 表达持久化状态，模型失败可能返回 `failed`，等待交互返回 `interrupted`；入口错误、取消或资源关闭失败可能直接抛出。调用方既要处理异常，也要检查状态

`onRuntimeEvent` 观察运行事实，用于终端展示或宿主传输；`RuntimeEvent` 与厂商原始流式事件不同。模型提供可见思考时才能展示思考，事件处理不替代读取 Store 的权威状态

多轮对话、运行中引导与中断见 [AgentEngine](agent-engine.md) 和 [运行控制](agent-control.md)；显式委派、等待及角色配置见 [子智能体](subagents.md)。后台 `submit()` 用于已持久化的后台 Turn，不能把它当作任意异步任务队列；可恢复子任务由 Engine 的工作区恢复流程统一接管
