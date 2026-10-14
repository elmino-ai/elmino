import type { EventHandler, Message, ModelTurnConfig, Provider, Request, Result, TurnModel } from '@elmino/llm'
import { EMPTY_USAGE, parseObject } from '@elmino/llm'

/** 一次模型采样的确定响应或失败，回调可精确控制并发与取消 */
export type ModelReaction = Result | Error | ((request: Request, emit?: EventHandler) => Promise<Result>)

/** 从实际模型协议构造响应，不复制厂商 SDK 映射 */
export function response(parts: Message['parts'], finishReason: Message['finishReason'] = 'completed'): Result {
  return {
    message: { role: 'assistant', parts, finishReason },
    usage: { ...EMPTY_USAGE, input: 10, output: 2 },
  }
}

/** 测试模型持有当前文件独立的响应序列与公开请求记录 */
export function createModel(reactions: ModelReaction[]) {
  const requests: Request[] = []
  let index = 0
  const sample = (request: Request, emit?: EventHandler): Promise<Result> => {
    requests.push({ ...request, messages: structuredClone(request.messages) })
    const reaction = reactions[index++]
    if (!reaction)
      return Promise.reject(new Error('模型请求超过预设采样次数'))
    if (reaction instanceof Error)
      return Promise.reject(reaction)
    return typeof reaction === 'function' ? reaction(request, emit) : Promise.resolve(reaction)
  }
  const adapter: Provider = {
    name: 'test',
    model: 'test-model',
    capabilities: { cache: { modes: ['disabled'] }, reasoning: true, tools: true, jsonSchema: true },
    generate: request => sample(request),
    generateObject: async request => parseObject(await sample(request), request.schema),
    stream: async (request, emit) => {
      const result = await sample(request, emit)
      for (const [index, part] of result.message.parts.entries()) {
        await emit?.({ type: 'part-start', index, part })
        if (part.type === 'text' || part.type === 'reasoning')
          await emit?.({ type: 'part-delta', index, delta: { type: part.type, text: part.text } })
        if (part.type === 'tool-call') {
          await emit?.({
            type: 'part-delta',
            index,
            delta: { type: 'tool-args', text: JSON.stringify(part.args) },
          })
        }
        await emit?.({ type: 'part-end', index, part })
      }
      await emit?.({ type: 'usage', usage: result.usage })
      return result
    },
  }
  const model: TurnModel<ModelTurnConfig> = {
    config: {
      id: 'model_test',
      providerId: 'provider_test',
      providerName: 'test',
      name: 'test-model',
      label: 'Test Model',
      apiFormat: 'anthropic-messages',
      baseURL: 'https://example.test',
      cache: { mode: 'disabled' },
      limit: { context: 1_000_000 },
      jsonSchema: true,
      inputModalities: [],
    },
    adapter,
  }
  return { model, requests }
}
