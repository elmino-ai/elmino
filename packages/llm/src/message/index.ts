/** -------------------- Canonical Message 协议出口 -------------------- */
export { extractReasoning, extractText, toolCalls } from './content'
export { attachToolResults, createToolResultPart, pendingToolCalls } from './tool-results'
export type {
  DocumentPart,
  FinishReason,
  ImagePart,
  Message,
  Part,
  ReasoningPart,
  Role,
  TextPart,
  ToolCallPart,
  ToolResultContent,
  ToolResultPart,
} from './types'
