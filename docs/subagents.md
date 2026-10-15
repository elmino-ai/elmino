# 子智能体：显式委派与等待

[subagents](../examples/reference/subagents) 由父模型调用两次 `delegate_task`，分别派生独立子任务，等待各自结果后汇总。创建子线程、派生关系、排队和执行结算都由同一个 AgentEngine 负责

## 运行

在自己的 `.env` 中填写模型凭据后启动：

```sh
cp examples/reference/subagents/.env.example examples/reference/subagents/.env
pnpm example:subagents
```

示例为子任务使用内置 `explorer` 角色，复用本轮模型，且明确要求子任务只回答问题、不再派生任务。多个采样会产生比普通单次任务更多的模型调用；整次运行期限为两分钟

## 工具接入控制面

Engine 不会自动给 Agent 添加派生工具；宿主通过 `defineTools()` 声明实际需要的工具，从执行上下文读取服务：

```ts
import { subagentHostService } from '@elmino/tool'

if (!context.services || !context.toolCallId)
  throw new Error('需要根 Turn 的宿主服务和工具调用身份')
const controller = context.services.require(subagentHostService)
const child = await controller.spawn({
  ownerId: 'example-subagents',
  role: 'explorer',
  name: '解释 Thread',
  description: '只用一句话解释 Thread 的含义',
  parentToolCallId: context.toolCallId,
})
```

完整代码会检查宿主服务与调用身份存在，见 [delegate.ts](../examples/reference/subagents/src/tool/delegate.ts)。这里的 `toolCallId` 是工具执行上下文提供的 **RuntimeStore ID**，不是模型输出中的 Provider 原生调用 ID

一个父工具调用关联一个子 Turn，重复提交同一调用会找回已有子任务。要创建两个独立任务，应发起两个不同的工具调用；不能在同一个工具调用里反复 `spawn()` 并期待创建多个子任务。示例将 `parallel: true` 显式用于相互独立的委派调用

## 等待与真实状态

`spawn()` 只提交任务，不保证任务已结束。`controller.wait({ threadIds, timeoutMs })` 等待目标任务进入可观察的稳定状态或超时，返回当时的快照；不是无条件等待所有目标成功

示例仅对 `queued`、`running` 继续等待，每次只等待当前工具派生的子线程。其他状态连同 `result` 或 `error` 一并交还父模型：子任务可能成功、失败、被中断或等待交互，父任务应明确说明结果，而不是把“等待返回”当作成功

`controller.list()` 列出当前父线程的直接子任务，`controller.interrupt(childThreadId)` 中断指定直接子任务。这些操作受父线程归属约束，不能跨父线程读取或控制别人的任务。工具可以通过 `thread.child.updated` 事件展示进度，最终仍以存储事实为准

## 角色与宿主边界

Engine 默认提供 `default`、`explorer`、`worker` 三种角色。需要定制目录时，在直接创建 Engine 时传 `subagentRoles()`；角色在根 Turn 启动时冻结，恢复沿用冻结事实。`LocalSubagentRoles` 可管理宿主指定目录中的 Markdown 角色，不会默认读取产品配置

`subagentMode` 默认 `explicitOnly`。设置 `proactive` 也不会自动注册工具或替宿主实现调度入口。子任务继续使用当前 Agent 的行为与运行环境，模型不是任意独立产品 Agent 注册项；子任务的控制服务也不代表无限嵌套派生

`runAgent()` 的示例在父工具内等待子任务结果，因此入口关闭 Engine 前，演示中的子任务已经结算。生产宿主要跨请求保留排队任务时，应显式持有 Engine，并在重启恢复时提供按冻结配置重建模型的 `restoreModel()`，通过 `recoverWorkspace()` 接管可恢复子任务

| 源码 | 内容 |
| --- | --- |
| [agent/agent.ts](../examples/reference/subagents/src/agent/agent.ts) | 父任务与子任务的行为约束 |
| [tool/delegate.ts](../examples/reference/subagents/src/tool/delegate.ts) | 从宿主服务派生单个任务并等待 |
| [app/run.ts](../examples/reference/subagents/src/app/run.ts) | 真实模型、事件展示与单次运行 |
| [tests/subagents.test.ts](../examples/reference/subagents/tests/subagents.test.ts) | 验证两个独立派生关系及子任务失败结果，不调用真实模型 |

运行和取消语义见 [Agent 使用指南](agent.md)、[引擎参考](agent-engine.md) 与 [运行控制](agent-control.md)
