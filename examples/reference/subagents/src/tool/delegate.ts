/**
 * 单个委派工具的生命周期：取得控制服务 → 派生一个子任务 → 等待其状态 → 回传父模型
 *
 * Engine 注入控制服务，示例只声明给模型使用的工具，不创建第二套子任务执行器
 * parentToolCallId 决定父调用与子 Turn 的关联；同一个调用重复 spawn 会找回原子任务
 * 要并行创建两个任务，父模型必须发起两个不同的 delegate_task 调用
 */
import { defineTools, subagentHostService } from '@elmino/tool'
import { z } from 'zod'

/** 一个父工具调用关联一个子 Turn；两个独立任务应使用两个工具调用 */
export const tools = defineTools({
  delegate_task: {
    description: '将一个独立问题交给探索者，等待并返回其状态和回答',
    schema: z.object({ name: z.string().min(1), task: z.string().min(1) }),
    scope: 'inspect',
    // 允许同批独立委派并行执行；共享文件修改等有依赖的工具不能机械开启这个选项
    parallel: true,
    async execute({ name, task }, { services, toolCallId, signal }) {
      if (!services || !toolCallId)
        throw new Error('此工具需要根 Turn 的宿主服务和工具调用身份')
      // 第 1 步：读取当前根 Turn 的控制面，不能在普通函数里凭空创建这个服务
      const controller = services.require(subagentHostService)
      // 第 2 步：spawn 返回已提交的任务快照，不意味着子模型已经回答完成
      let child = await controller.spawn({
        // 所有者是宿主能力的稳定语义键，不是随机生成的任务身份
        ownerId: 'example-subagents',
        // 角色 ID 来自 Engine 的角色目录，不是另一个已注册 Agent 的 id
        role: 'explorer',
        name,
        description: `${task}\n只返回简洁答案，不调用工具，不再派生任务`,
        // 这里必须用执行上下文提供的 RuntimeStore ID，不能改用模型原生调用 ID
        parentToolCallId: toolCallId,
      })
      // 第 3 步：只对仍在排队/运行的状态继续等；超时快照也要重新检查状态
      while (child.status === 'queued' || child.status === 'running') {
        signal?.throwIfAborted()
        // 每次最多等待十秒，整次任务仍受 app/run.ts 的两分钟取消信号控制
        const result = await controller.wait({ threadIds: [child.threadId], timeoutMs: 10_000 })
        const current = result.subagents[0]
        if (!current)
          throw new Error('等待结果缺少对应子任务')
        child = current
      }
      // 第 4 步：成功、失败或等待交互的事实都交给父模型，不把“等到返回”包装成成功
      return JSON.stringify(child)
    },
  },
})
