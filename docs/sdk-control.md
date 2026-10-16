# SDK 运行控制

使用 SDK 操作 Server 时，通常只需要三个对象：`Client` 连接服务，`ClientThread` 固定 Agent、工作区和会话，`ClientRun` 固定一次执行及其控制目标。页面不需要自己拼恢复请求、维护 SSE 游标或判断任务是否结束

先学习 [05 · SDK](sdk-example.md) 的最简单调用。本文覆盖继续聊天、引导与停止、审批、刷新后重新观察，以及可选的 Composer、React 和 Query 接入

## 运行完整参考

```sh
pnpm example:sdk-control
```

[Reference 源码](../examples/reference/sdk-control/src/app/run.ts) 自动启动临时本机 Server，使用确定性教学模型，依次展示三条路径：

1. 启动任务，向当前执行追加要求，再停止任务
2. 结束本地观察，通过保存的线程与 Turn 身份重新连接，继续等待原任务
3. 批准工具后恢复原 Turn，再演示取消另一个完整的待审批任务

这个参考不需要 `.env` 或外部模型密钥；它专门稳定展示 SDK 控制行为。真实 DeepSeek 接入见 Tutorial。每次运行使用独立临时目录，结束时关闭 Server、Elmino 和存储租约，保留并打印数据目录供查看

`src/index.ts` 只启动示例，`app/run.ts` 展示客户端用法。`agent` 中的等待门控保证控制请求发生时工具仍在运行，不是 SDK 的必需配置；正式工具只需正确响应执行信号。`server`、`runtime` 和 `model` 属于演示宿主装配，远端调用者不需要编写这些代码

## 绑定会话与继续聊天

```ts
import { Client } from '@elmino/sdk'

const client = Client.create({ baseUrl: 'http://127.0.0.1:3000' })
const thread = client.thread({ agentId: 'writer', workspaceId: 'project' })

await thread.run('分析这个项目')
await thread.run('继续，把结论整理成文档')
```

`thread()` 只绑定身份，不创建服务端空会话。省略 `threadId` 时由 SDK 分配，连续调用会沿用这个会话，每次创建新 Turn；同一会话正在执行或等待审批时，不应再提交新的聊天来替代当前交互

如果只需要一次调用，仍可使用 `client.run({ agentId, workspaceId, input })`。它与 `thread.run()` 共用同一执行逻辑

## 启动、引导与停止

需要在运行中响应用户操作时，使用 `start()` 立即拿到执行句柄：

```ts
const task = thread.start('分析这个项目', {
  onText: text => console.log(text),
})

// 分别绑定到界面的“补充要求”和“停止”操作
const steer = () => task.steer('先重点检查存储模块')
const stop = () => task.interrupt('用户停止当前任务')

const result = await task.completed
```

`task.threadId` 和 `task.turnId` 在提交前就可保存。`task.accepted` 表示服务端已接纳；`steer()` 与 `interrupt()` 会先等待接纳，再控制这个准确的 Turn，不会在下一轮开始后误选新任务

引导在执行安全边界消费，不会立即替换正在执行的工具。停止会等待服务端结算当前执行，实际结果仍应读取 `task.completed`：停止与任务自然完成可能同时发生。已经结束的任务不能继续接纳引导

`run()` 等价于 `start(...).completed`，结果中的 `completed`、`failed`、`cancelled`、`interrupted` 是运行状态；传输、鉴权和回调异常通过 Promise 拒绝返回，调用方应处理异常

## 处理审批与其他交互

等待交互时，本次执行片段返回 `interrupted`，并提供完整的 `result.interaction`。这个对象已经携带 Agent、工作区、线程、Turn 和中断身份：

```ts
const result = await thread.run('执行需要审批的工具')
if (result.interaction?.approval) {
  // 先交给界面展示，让用户决定；点击批准后调用这一行
  const resumed = thread.approve(result.interaction)
  // 恢复期间也可以调用 resumed.interrupt()、steer() 或 detach()
  const next = await resumed.completed
  console.log(next.status)
}
```

`approve()`、`reject()`、`respond()` 和 `resume()` 都立即返回 `ClientRun`，通过 `accepted` 等待接纳，通过 `completed` 等待本次恢复片段的结果。模型、权限与上下文继续使用冻结配置，不会创建一个替代 Turn。恢复前已经显示的内容不会通过恢复调用的输出回调重新输出；原交互过期时返回冲突，不自动选择新审批

| 用户操作 | 调用 | 行为 |
| --- | --- | --- |
| 批准整批工具 | `thread.approve(interaction, options?)` | 覆盖当前批次全部工具，恢复原 Turn |
| 拒绝整批工具 | `thread.reject(interaction, message?, options?)` | 工具不执行，模型仍可解释或选择其他办法 |
| 分别批准、拒绝、编辑或人工回复 | `thread.respond(interaction, decisions, options?)` | 必须完整覆盖本批请求及其允许的决策 |
| 恢复自定义交互 | `thread.resume(interaction, response, options?)` | JSON 回复由宿主交互定义解释 |
| 取消整个待审批任务 | `thread.cancel(interaction, reason?, options?)` | 原 Turn 结算为 `cancelled`，清除交互，不再运行模型 |

`options` 可提供本地等待信号；恢复执行的操作还可提供正文、思考、工具和事件回调。`cancel()` 返回取消后的结果，不执行新的模型采样

逐项决策时，从当前 `interaction.approval.actionRequests` 读取每个 `callId`，从 `reviewConfigs` 读取允许的操作。例如，为一个请求修改工具参数：

```ts
const interaction = result.interaction
const action = interaction?.approval?.actionRequests[0]
if (interaction && action && interaction.approval?.actionRequests.length === 1) {
  const resumed = thread.respond(interaction, [{
    type: 'edit',
    callId: action.callId,
    editedAction: { name: action.name, args: { text: '用户确认后的内容' } },
  }])
  await resumed.completed
}
```

这里的参数仅用于演示具有 `text` 字段的工具，真实参数应按目标工具定义填写。人工提供结果使用 `{ type: 'respond', callId, message }`；混合批次需为每个请求提供一项决策。SDK 校验批次匹配，服务端再次校验当前交互及允许的操作

**继续聊天、审批恢复、运行中引导是三种不同操作**：`run()` 新建 Turn，`approve()` 等操作恢复原 Turn，`steer()` 在当前活跃 Turn 追加输入。拒绝工具后的模型仍可能继续执行；要停止整个待审批任务使用 `cancel()`

## 刷新后重新观察

只结束本地观察时调用 `detach()`，原任务继续运行。本地 `completed` 会拒绝，应用应处理这个取消结果：

```ts
const task = thread.start('完成长任务')
await task.accepted
const saved = { threadId: task.threadId, turnId: task.turnId }

// 页面卸载等情况下停止当前观察；保存 saved 到应用自己的状态
const waiting = task.completed.catch(() => undefined)
task.detach()
await waiting

const restored = client.thread({
  agentId: 'writer',
  workspaceId: 'project',
  threadId: saved.threadId,
})
const result = await restored.attach(saved.turnId).completed
```

`attach()` 查询与订阅已经存在的执行，不发送 `turn.create()`，可以重新连接仍在运行、已经结束或等待交互的 Turn。已结束时直接返回结果；等待审批时返回同一份交互，再用恢复方法处理

重新观察的句柄会从持久快照提供该 Turn 已有的输出。应用若已经展示部分内容，优先使用下面的 `watch()` 用完整状态更新界面，避免跨不同观察句柄重复追加文本

`signal` 超时、`detach()`、取消订阅和退出客户端都只影响本地等待，不自动停止已接纳任务。停止远端执行使用 `interrupt()`；取消待交互任务使用 `cancel()`

## 查询历史与实时界面

`ClientThread` 是同一会话消息与连接状态的唯一客户端所有者。需要同步快照时，使用引用稳定的 `getSnapshot()` 和 `subscribe()`：

```ts
const unsubscribe = thread.subscribe(() => {
  const snapshot = thread.getSnapshot()
  console.log(snapshot.status, snapshot.thread?.messages, snapshot.error)
})

// 退出当前视图时释放这一个观察者
unsubscribe()
```

`getSnapshot()` 本身不发送请求。首次订阅建立观察，最后退订释放这个会话句柄的连接与重试资源；`status` 表示本地连接状态，远端运行状态读取 `snapshot.thread?.runtime`。订阅者取得同一份会话快照，不各自投影消息

需要异步处理完整状态时，继续使用 `watch()`：

```ts
const history = await thread.get()
const stopWatching = thread.watch(state => {
  // 用这份状态更新界面；state.messages、turns 和 runtime 均属于当前线程
  console.log(state.messages, state.runtime)
}, {
  onError: error => console.error('观察暂时中断', error),
})

// 页面卸载时调用；其他观察者与远端任务继续运行
stopWatching()
```

`get()` 返回完整线程快照，`watch()` 先读取状态，再跟随消息与状态变化，断线后查询权威快照校准。实时正文在客户端合并，终态与审批等状态以服务端投影为准；不用自己管理原始事件或回放游标。尚未首次执行的会话仍可能返回 `NOT_FOUND`

需要分页历史或查询失败原因时，使用独立的只读入口：

```ts
const turns = await thread.listTurns()
const latest = await thread.readTranscript({ limit: 10 })
if (latest.nextCursor) {
  const earlier = await thread.readTranscript({ cursor: latest.nextCursor, limit: 10 })
  console.log(earlier.messages)
}
```

`listTurns()` 返回最近创建优先的运行记录，包含冻结模型、权限与持久失败原因。`readTranscript()` 按完整 Turn 分页，页内消息按时间正序，`nextCursor` 指向更早历史；最新页包含当前运行已观察到的流式内容。历史页由调用方用于历史展示，不覆盖当前 `ClientThread` 实时快照

同一个 Client 下的会话执行与状态观察共享所属 Agent / 工作区的连接通道。每个执行或观察者分别释放；最后一个观察者离开后，SDK 释放连接、读取器与重连计时器

各观察者独立处理回调，某个页面更新较慢不会阻塞其他任务。积压超过队列容量时，通过权威快照补齐状态和输出；快照查询暂时失败会自动退避重试。高层 `onEvent` 适合辅助展示，不保证积压期间逐条交付原始事件；需要逐事件处理时使用独立的 `client.subscribe()`

服务发现和列表也有直接入口：

```ts
await client.health()
const agents = await client.listAgents()
const threads = await client.listThreads({ agentId: 'writer', workspaceId: 'project' })
```

线程列表使用服务端现有的前缀数量限制，可传 `limit` 和 `archived`，返回 `items`、`hasMore`。线程重命名、归档和删除尚未提供完整服务能力，不能通过 SDK 方法实现这些操作

## 草稿与本地队列

`Composer` 固定绑定一个 `ClientThread`，只负责草稿与本地队列。它接受字符串或既有的结构化输入，不负责模型目录、附件读取、账号或设备存储：

```ts
import { Composer } from '@elmino/sdk'

const composer = Composer.create({ thread })
const unsubscribe = composer.subscribe(() => {
  console.log(composer.getSnapshot())
})

try {
  composer.setInput('先分析项目')
  const submission = await composer.submit()
  if (submission.status === 'submitted') {
    // 提交只等待接纳，执行结果和控制仍使用原运行句柄
    console.log(await submission.run.completed)
  }
}
finally {
  unsubscribe()
  composer.dispose()
}
```

`setInput()` 也可以传文本、引用、图片或文档输入数组，使用与 `thread.start()` 相同的领域结构；宿主在调用前准备附件内容。`submit({ modelId?, approvalMode?, subagentMode? })` 冻结本次策略，接纳前保留原草稿，迟到回执不会清空后来输入的新草稿

运行中的提交返回 `queued`，队列按当前会话顺序等待发送。`removeQueuedInput(id)` 删除、`moveQueuedInput(from, to)` 排序、`editQueuedInput(id)` 移回草稿；正在确认接纳的队列不能编辑。空白输入、重复提交和待处理交互返回 `blocked`，原因在 `reason` 中

队首发送前标记为 `paused`，接纳后才移除；提交结果未知时保留暂停项，不自动重试。原运行失败、被停止或等待交互时暂停剩余队列，用户可编辑后明确重提。仍有可发送队列时，Composer 持有会话订阅；`dispose()` 结束本地调度，不停止已接纳的远端任务

## 可选 React 与 Query 接入

基础 `@elmino/sdk` 不加载 React 或 TanStack Query。React 应用安装可选的 React 依赖后，从独立入口取得 Hook：

```ts
import { useComposer, useThread } from '@elmino/sdk/react'

// 放在既有 React 组件或自定义 Hook 中，传入宿主持有的稳定对象
const session = useThread(thread)
const draft = useComposer(composer)
```

两个 Hook 只通过 `useSyncExternalStore` 读取原对象的快照，动作继续调用 `thread.start()`、`thread.approve()`、`composer.setInput()` 和 `composer.submit()`。在同一会话生命周期内复用对象，避免每次渲染重新创建；组件卸载只退订自身，Composer 的关闭由创建它的宿主决定

需要查询缓存时，安装可选的 `@orpc/tanstack-query` 和 `@tanstack/query-core`，从独立 Query 入口取得 oRPC 原生 utilities：

```ts
import { createApiQueryUtils } from '@elmino/sdk/query'
import { QueryClient } from '@tanstack/query-core'

const queries = createApiQueryUtils(client)
const queryClient = new QueryClient()
const agents = await queryClient.fetchQuery(queries.agent.list.queryOptions({ input: {} }))
console.log(agents)
```

utilities 使用原 `client.rpc` 和按服务地址隔离的缓存键。Query 缓存目录或列表等请求结果，实时会话状态继续由 `ClientThread` 拥有；SDK 不创建另一套消息缓存，也不自动创建 `QueryClient`

## 需要原始传输时

普通会话与执行优先使用上述对象。自定义协议投影、宿主扩展接口或工作区事件看板仍可使用 `client.rpc`、`client.subscribe()` 和 `client.transport()`，见 [Server 与 SDK](server-sdk.md#高级-rpc-与事件订阅)
