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
    const part = readRuntimeEventPartPayload(event)

    if (part && (part.type === 'reasoning' || part.type === 'text')) {
      const length = parts.get(part.id)?.length ?? 0

      parts.set(part.id, { type: part.type, length: part.text.length })
      write(part.id, part.type, part.text.slice(length))
      return
    }

    const payload = readRuntimeEventPartDeltaPayload(event)
    const printed = event.partId ? parts.get(event.partId) : undefined

    if (event.partId && printed && payload && 'text' in payload.delta) {
      printed.length += payload.delta.text.length
      write(event.partId, printed.type, payload.delta.text)
    }
  }
}
