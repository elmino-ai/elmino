/** -------------------- 模块出口 -------------------- */
export { ThreadCommitter } from './commit/committer.js'
export { settleTurnOutputTx } from './commit/step.js'
export type {
  CheckpointInput,
  CompactionInput,
  InitializeInput,
  MessageRef,
  PartialCommitInput,
  StepCommitInput,
  TurnRef,
} from './commit/types.js'
export {
  appendCanonicalMessage,
  appendCanonicalMessages,
  canonicalRecordToMessage,
  canonicalToolResultToText,
} from './context/canonical.js'
export type { AppendCanonicalMessageInput } from './context/canonical.js'
export { readThreadMentionReference } from './input/mention.js'
export { readThreadInputText, sortThreadInputContent } from './input/text.js'
export type {
  ResumeTurnInput,
  ThreadInputContent,
  ThreadInputDocumentContent,
  ThreadInputImageContent,
  ThreadInputMentionContent,
  ThreadInputTextContent,
} from './input/types.js'
export type { ThreadContextBudget, ThreadContextBudgetEstimation, ThreadUsagePayload } from './runtime/budget.js'
export type {
  RuntimeMessagePartDelta,
  RuntimeMessagePartDeltaPayload,
  RuntimeTextPartDelta,
  RuntimeToolOutputPartDelta,
} from './runtime/delta.js'
export {
  applyRuntimeToolOutputDelta,
  readRuntimeEventPartDeltaPayload,
  readRuntimeEventPartPayload,
} from './runtime/delta.js'
export type { CreateRuntimeEventInput, RuntimeEvent, RuntimeEventType } from './runtime/event.js'
export { createRuntimeEvent, RUNTIME_EVENT_TYPES, TERMINAL_TURN_EVENT_TYPES } from './runtime/event.js'
export type {
  ThreadInteractionInterrupt,
  ThreadInterrupt,
  ThreadInterruptKind,
  ThreadInterruptResumeAction,
  ThreadInterruptStatus,
} from './runtime/interrupt.js'
export { readThreadInteraction, readThreadInterrupt } from './runtime/interrupt.js'
export type { ThreadRuntimeState } from './runtime/state.js'
export { hydrateThreadMessages } from './thread/hydrate.js'
export { runtimeRecordsToThreadListItem } from './thread/list.js'
export { defineThread } from './thread/projection.js'
export {
  readThreadSnapshot,
  removeThreadSnapshot,
  runtimeRecordsToThreadSnapshot,
  runtimeSummaryToThreadSnapshot,
  updateThreadExtensionState,
  updateThreadExtensionStateTx,
  updateThreadSnapshot,
  writeThreadSnapshot,
} from './thread/snapshot-store.js'
export { createThreadSnapshotRecord } from './thread/snapshot.js'
export type { ThreadChildState, ThreadListItem, ThreadState, ThreadTurnState } from './thread/state.js'
export type {
  ContextProjectionState,
  CreateThreadSnapshotRecordInput,
  NormalizedThreadSnapshotRecord,
  Thread,
  ThreadExtensionState,
  ThreadExtensionStatePatch,
  ThreadSnapshotRecord,
  ThreadSnapshotUpdate,
  ThreadStateInput,
  ThreadToolPart,
  ThreadToolPartProjector,
} from './thread/types.js'
export { readAffectedThreadUsages, readThreadUsage } from './thread/usage.js'
export { commitToolState, projectLiveToolPart, updateToolPart } from './tool/index.js'
export type { LiveToolPartInput } from './tool/projection.js'
export type { CommitToolStateInput, RuntimeEmitter } from './tool/state.js'
