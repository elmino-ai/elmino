import { Client } from '@elmino/sdk'
import { throwSettledErrors } from '@elmino/shared'
import { createExampleServer } from '../server/server'

/**
 * 三条常见控制路径；所有执行与交互都经过真实本机 HTTP
 * 门控只让演示顺序稳定，任务身份、控制请求和审批语义来自正式 SDK
 */
export async function runExample() {
  // 同时取得临时服务、控制工具顺序的门控和保留运行记录的位置
  const { server, gates, dataDir } = await createExampleServer()
  try {
    // 随机空闲端口避免影响正在运行的 Tutorial Server；退出由本例 finally 统一处理
    const url = await server.start({ port: 0, hostname: '127.0.0.1', shutdownSignals: false })
    // 客户端通过真实 HTTP 访问刚启动的服务
    const client = Client.create({ baseUrl: url })
    // 三组独立会话共用同一个 Agent 与工作区
    const target = { agentId: 'assistant', workspaceId: 'example' }
    // 演示超时仅取消客户端观察，避免出现无限等待
    const options = { signal: AbortSignal.timeout(15_000) }

    // 1. start 立即提供身份和控制句柄；控件不必等整个任务完成才拿到 Turn ID
    const thread = client.thread(target)
    // start 立即返回控制句柄，accepted 与 completed 分别表示接纳和本轮结束
    const task = thread.start('等待 interrupt', options)
    await Promise.race([gates.interrupt.entered, task.completed])
    await task.steer('用户补充：只用一句话回答')
    await task.interrupt('用户停止当前任务')
    console.log('引导后停止：', (await task.completed).status)

    // 2. detach 只结束本地观察；重新绑定身份后 attach 不会重复提交任务
    // 让工具等待宿主释放，确保 detach 后远端仍有一个可重新观察的任务
    const original = client.thread(target).start('等待 attach', options)
    await Promise.race([gates.attach.entered, original.completed])
    // 提前接住 detach 导致的本地完成 Promise 拒绝，避免未处理的异常
    const detached = original.completed.catch(() => undefined)
    original.detach()
    await detached
    // 重新绑定原线程身份；这一步不在服务端创建新会话
    const restored = client.thread({ ...target, threadId: original.threadId })
    // attach 观察已有 Turn，不重发输入，也不重新执行任务
    const attached = restored.attach(original.turnId, options)
    await attached.accepted
    gates.attach.release()
    console.log('重新观察原任务：', (await attached.completed).status)

    // 3. 待审批结果自带交互身份，不用拼 interruptId 或恢复 JSON
    // 为审批单独创建会话，避免复用上面停止或已完成的工具上下文
    const review = client.thread(target)
    // run 在工具等待人工审批时返回 interrupted 及绑定原中断的 interaction
    const pending = await review.run('请回显：Hello from elmino', options)
    if (!pending.interaction)
      throw new Error('教学工具应进入审批状态')
    console.log('待审批工具：', pending.interaction.approval?.actionRequests)
    // 直接批准本次交互允许的动作，SDK 负责生成准确的恢复请求
    const approved = await review.approve(pending.interaction, options)
    console.log('批准后继续：', approved.status)

    // 用户选择停止整个待审批任务时使用 cancel；reject 则会让模型继续处理拒绝结果
    // 使用另一段会话展示整体取消，与批准后的运行相互独立
    const cancelledThread = client.thread(target)
    // 再次停在审批点，供用户选择取消整个任务
    const next = await cancelledThread.run('这次直接取消整个任务', options)
    if (!next.interaction)
      throw new Error('教学工具应进入审批状态')
    // cancel 绑定此处的待处理交互，过期审批不能取消后续运行
    const cancelled = await cancelledThread.cancel(next.interaction, '用户取消整个任务', options)
    console.log('取消待审批任务：', cancelled.status)
    console.log('示例运行数据保留于：', dataDir)
  }
  finally {
    // Server 只拥有 HTTP；创建方还要关闭 Elmino，才能释放 Engine 与 SQLite 租约
    // 两个关闭都执行完成后再汇总错误，单项失败不会跳过另一项资源释放
    const results = await Promise.allSettled([server.close(), server.elmino.close()])
    throwSettledErrors(results, '关闭 SDK 控制示例失败', true)
  }
}
