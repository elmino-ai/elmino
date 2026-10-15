/**
 * 工具定义：让模型提出结构化调用，由宿主执行实际操作
 *
 * description 告诉模型何时使用，schema 约束参数，execute 返回可回放给模型的结果
 * 文件路径相对于当前线程的 Sandbox 工作目录；工具不自行选择数据库或用户目录
 * 抛出的执行错误由 Loop 记录并回传模型，最终 Turn 是否成功还取决于后续执行
 */
import { defineTools } from '@elmino/tool'
import { z } from 'zod'

/** Hooks 只控制执行策略，文件操作仍由 Sandbox 承担 */
export const tools = defineTools({
  write_note: {
    description: '将便签内容写入工作区 result.txt',
    // 本工具沿用默认 approval: never；人工审批的写法见 agent-engine 参考
    schema: z.object({ text: z.string().min(1) }),
    // 声明这是修改类能力；作用范围分类与是否触发人工审批是两个独立配置
    scope: 'modify',
    async execute({ text }, { sandbox }) {
      // 返回的是执行环境的写入结果；将失败抛出，避免让模型误以为文件已保存
      const result = await sandbox.files.write('result.txt', text)
      if (result.error)
        throw new Error(result.error)
      return `已写入 ${result.path}`
    },
  },
})
