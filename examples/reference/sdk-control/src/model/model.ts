/**
 * 确定性教学模型，不访问外部服务
 *
 * 每个新会话的第一步调用工具，工具获得结果后第二步回复
 * 它只帮助稳定复现 SDK 生命周期；真实模型调用见 Tutorial 01—05
 */
import type { EventHandler, ModelTurnConfig, Provider, Request, Result, TurnModel } from '@elmino/llm'
import { EMPTY_USAGE, parseObject } from '@elmino/llm'
import { createId } from '@elmino/shared'

/**
 * 使用正式 Provider 契约，不从测试目录导入执行夹具
 */
export function createModel(): TurnModel<ModelTurnConfig> {
  /** 根据当前上下文确定调用工具还是结束回复，不发送外部模型请求 */
  const sample = (request: Request): Result => {
    request.signal?.throwIfAborted()
    // 首条用户消息决定该会话要演示等待工具还是审批工具
    const firstInput = request.messages.find(/** 选择本会话的原始用户请求 */ message => message.role === 'user')
    // 只读取文本片段，教学模型无需解析图片或资源引用
    const input = firstInput?.parts
      .flatMap(/** 忽略非文本片段，拼出用于选择演示路径的文本 */ part => part.type === 'text' ? [part.text] : [])
      .join('') ?? ''
    // 只调用一次工具；恢复审批或工具返回后进入最终答复
    const hasCall = request.messages.some(/** 查找任意历史工具调用，避免同一会话重复发起 */ message => message.parts.some(/** 识别工具调用片段 */ part => part.type === 'tool-call'))
    // 等待任务选择门控工具，其余输入选择需要人工审批的回显工具
    const parts = hasCall
      ? [{ type: 'text' as const, text: '工具已处理，本轮结束' }]
      : [{
          type: 'tool-call' as const,
          id: createId('call'),
          name: input.includes('等待') ? 'wait_for_host' : 'echo',
          args: input.includes('等待')
            ? { label: input.includes('attach') ? 'attach' : 'interrupt' }
            : { text: input },
        }]
    return {
      message: { role: 'assistant', parts, finishReason: hasCall ? 'completed' : 'tool-calls' },
      usage: { ...EMPTY_USAGE },
    }
  }
  /** 按正式 Provider 事件顺序发送确定性结果，让 SDK 经过真实事件链路 */
  const stream = async (request: Request, emit?: EventHandler): Promise<Result> => {
    // 非流式和流式入口使用相同结果，避免两套教学模型行为
    const result = sample(request)
    // 片段序号用于关联 start、delta 和 end；SDK 据此还原同一输出片段
    for (const [index, part] of result.message.parts.entries()) {
      await emit?.({ type: 'part-start', index, part })
      if (part.type === 'text')
        await emit?.({ type: 'part-delta', index, delta: { type: 'text', text: part.text } })
      await emit?.({ type: 'part-end', index, part })
    }
    await emit?.({ type: 'usage', usage: result.usage })
    return result
  }
  // 用完整 Provider 契约接入框架，调用和事件与真实供应商适配器一致
  const adapter: Provider = {
    name: 'teaching',
    model: 'sdk-control',
    capabilities: { cache: { modes: ['disabled'] }, reasoning: false, tools: true, jsonSchema: true },
    generate: stream,
    /** 结构化请求复用相同结果，再按调用方 Schema 解析 */
    generateObject: async request => parseObject(await stream(request), request.schema),
    stream,
  }
  return {
    config: {
      id: 'teaching',
      providerId: createId('provider'),
      providerName: 'teaching',
      name: 'sdk-control',
      apiFormat: 'anthropic-messages',
      baseURL: 'https://teaching.invalid',
      label: 'SDK 控制教学模型',
      cache: { mode: 'disabled' },
      limit: { context: 32_768 },
      inputModalities: [],
      jsonSchema: true,
    },
    adapter,
  }
}
