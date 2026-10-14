/** -------------------- 模块出口 -------------------- */
export { ContextProjection } from './context-projection/index.js'
export type {
  ContextProcessor,
  ContextProjectionOptions,
  ContextProjectionRequest,
} from './context-projection/index.js'
export type {
  ExecutionEventMap,
  ExecutionHooks,
  ExecutionNotification,
  ExecutionScope,
  PromptContextInput,
  PromptContextSection,
  PromptMessage,
  ToolBeforeResult,
  ToolInterruptResult,
  ToolProjectionResult,
  ToolResumeResult,
} from './hooks/index.js'
export { resolveLoopInteraction } from './interaction/index.js'
export { defineLoop } from './loop/define/index.js'
export type {
  Loop,
  LoopInvoker,
  TurnContext,
  TurnInput,
  TurnInputMessage,
  TurnOutcome,
  TurnOutcomeStatus,
  TurnResult,
  TurnResumeInput,
  TurnRuntimeEventHandler,
  TurnServices,
  TurnSteering,
} from './loop/define/index.js'
export { estimateTokens } from './token/index.js'
