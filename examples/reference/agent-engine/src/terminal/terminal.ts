/**
 * 事件展示：把框架的消息片段事件转为终端中的思考与回复
 *
 * 同一片段可能既收到增量，也收到完整快照，所以要按 partId 和已打印长度去重
 * 这里只展示模型实际返回的可见内容，不自行生成或推断思考过程
 * 模型与工具的最终状态仍以运行结果和 Store 为准，终端输出不是持久化状态
 */
import type { RuntimeEvent } from '@elmino/thread'
import { readRuntimeEventPartDeltaPayload, readRuntimeEventPartPayload } from '@elmino/thread'

/** 已打印片段的类型与字符数 */
interface PrintedPart {
  /** 终端中的内容分组 */
  type: 'reasoning' | 'text'
  /** 已输出字符数，用于排除完整片段中的重复内容 */
  length: number
}

/** 每次运行独立订阅可见思考与正文，按片段增量打印 */
export function createTerminalOutput(): (event: RuntimeEvent) => void {
  // partId 是一次输出片段的身份；已打印长度用于从完整快照中切出新增尾部
  const parts = new Map<string, PrintedPart>()
  let activePartId: string | undefined

  const write = (partId: string, type: PrintedPart['type'], text: string) => {
    if (!text)
      return
    if (activePartId !== partId) {
      process.stdout.write(`\n${type === 'reasoning' ? '思考' : '回复'}：\n`)
      activePartId = partId
    }
    process.stdout.write(text)
  }

  return (event) => {
    // 路径 A：完整片段事件可能先于增量到达，也可能用于补齐结束时的最终内容
    const part = readRuntimeEventPartPayload(event)

    if (part && (part.type === 'reasoning' || part.type === 'text')) {
      const length = parts.get(part.id)?.length ?? 0

      parts.set(part.id, { type: part.type, length: part.text.length })
      write(part.id, part.type, part.text.slice(length))
      return
    }

    // 路径 B：只把本次新增文本追加到终端，并同步长度，避免后续快照重复输出
    const payload = readRuntimeEventPartDeltaPayload(event)
    const printed = event.partId ? parts.get(event.partId) : undefined

    if (event.partId && printed && payload && 'text' in payload.delta) {
      printed.length += payload.delta.text.length
      write(event.partId, printed.type, payload.delta.text)
    }
  }
}
