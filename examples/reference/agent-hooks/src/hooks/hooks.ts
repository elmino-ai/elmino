/**
 * 观察一次成功执行：Turn 启动 → 系统上下文 → 工具策略 → 工具结果 → 快照 → 清理
 *
 * 框架按执行阶段调用 Hook，对象中各属性的声明顺序不决定回调顺序
 * 默认任务会成功写便签；被阻断与参数无效的路径可在 tests/hooks.test.ts 中对照
 * 本例的标记检测仅用于演示策略，不是通用安全过滤器
 */
import type { AgentHooks } from '@elmino/agent'
import { isPlainRecord } from '@elmino/shared'

/** 展示上下文、工具改写/阻断和 Turn 清理，不替代工具 Schema 或 Sandbox 权限 */
export function createHooks(log: (message: string) => void): AgentHooks {
  return {
    // 模型请求阶段：首次请求读取这段上下文，并在当前执行切片中保持稳定
    promptStable: () => [{ tag: 'note-policy', content: '便签内容应简洁；只保存用户指定的内容' }],
    // Turn 启动阶段：先于模型请求执行；返回的清理回调会在执行作用域退出时调用
    onStarted: ({ context }) => {
      log(`Turn 启动 ${context.turnId}`)
      return () => log(`Turn 清理回调 ${context.turnId}`)
    },
    // 工具执行前：检查原始参数；无效参数留给工具 Schema 报告
    beforeTool: ({ part }) => {
      if (part.name !== 'write_note' || !isPlainRecord(part.args) || typeof part.args.text !== 'string')
        return
      // Hook 可以收到原始参数，只收窄需要读取的字段；最终校验仍由工具 Schema 负责
      const { text } = part.args
      // block 会跳过处理器；模型会看到阻断原因，后续仍可解释或调整任务
      if (text.includes('[禁止写入]'))
        return { decision: 'block', reason: '示例策略禁止写入带有 [禁止写入] 标记的便签' }
      // 改写的是实际执行参数；框架随后仍会校验 Schema 和授权，不能借此扩大权限
      return { updatedArgs: { text: text.trim() } }
    },
    // 工具成功执行后：观察结果；被 beforeTool 跳过的调用不会来到这里
    afterTool: ({ part, status }) => log(`工具完成 ${part.name} ${status}`),
    // 结束前先收束扩展工作，再保存快照；onStarted 返回的清理函数在之后退出作用域时执行
    beforeSnapshot: ({ status }) => log(`准备保存执行快照 ${status}`),
  }
}
