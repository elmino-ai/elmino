# 运行控制：引导与中断

[turn-control](../examples/reference/turn-control) 展示如何准确控制一个活跃 Turn。它使用真实模型，并提供一个等待工具，让用户有稳定的终端操作窗口；等待工具仅用于演示，不是引擎要求

## 运行

在自己的 `.env` 中填写模型凭据后启动：

```sh
cp examples/reference/turn-control/.env.example examples/reference/turn-control/.env
pnpm example:turn-control
```

模型进入 `wait_for_input` 后，终端提示输入补充需求，或输入 `/stop` 中断本次任务。执行期限为两分钟，包含等待输入的时间。示例每次使用独立临时目录，结束后保留运行事实

## 引导当前 Turn

```ts
await engine.steer({
  agentId,
  threadId,
  turnId,
  store,
  text: '请只用一句话回答',
})
```

`steer()` 将补充消息持久化并接纳到**指定活跃 Turn**，在 Step 安全边界进入模型上下文。它不会立即打断当前工具，也不会创建新 Turn。示例先提交引导，再结束等待工具，因此下一次模型请求可以读取新要求

`accepted` 表示原任务已接纳，不保证用户稍后操作时它仍在运行。目标已结束、正在结算、中断或身份不匹配时，引导会拒绝；宿主应向用户展示当前状态，不把同一请求偷偷改投另一轮。多轮聊天则保留 `threadId`，生成新 `turnId` 后调用 `run()`

## 中断当前 Turn

```ts
const changed = await engine.interrupt({
  agentId,
  threadId,
  turnId,
  store,
  reason: '用户停止本次任务',
})
```

传入 `turnId` 可以避免迟到的停止请求影响下一轮。返回 `true` 表示本次命中了需要中断的执行，`false` 表示没有新的中断需要施加；函数等待相应执行结算。前台执行通常保存为 `interrupted`，`completed` Promise 可能拒绝，不能据此直接判定为普通模型失败

示例只把“用户主动选择中断，且持久化状态确为 `interrupted`”作为预期结果；其他失败继续报告。工具和 Provider 应响应各自收到的 `signal`，否则关闭或中断也必须等待这些工作结束

单次入口也可直接传 `AbortSignal`，通过 `AbortController.abort()` 或 `AbortSignal.timeout()` 请求取消；取消后仍要等待调用结算，不能提前关闭存储

## 生命周期与入口

操作必须使用运行时的同一 Agent、Thread、Turn 和工作区 Store。Hooks 的 Turn 清理、线程 Runtime 的释放和 Engine 的关闭按各自所有权进行，最后才释放存储租约

| 源码 | 内容 |
| --- | --- |
| [app/run.ts](../examples/reference/turn-control/src/app/run.ts) | 终端输入直接调用 `steer` 或 `interrupt` |
| [engine/control.ts](../examples/reference/turn-control/src/engine/control.ts) | 显式管理执行、操作窗口、结果和资源关闭 |
| [agent/agent.ts](../examples/reference/turn-control/src/agent/agent.ts) | 配合执行取消信号的等待工具 |
| [tests/control.test.ts](../examples/reference/turn-control/tests/control.test.ts) | 验证引导进入下一次请求、中断结算和未进入等待工具时的失败路径 |

审批中断使用 `resume()` 恢复原 Turn，见 [引擎参考](agent-engine.md)。本例不提供跨进程续接命令
