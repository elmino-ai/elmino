import { defineRelations } from 'drizzle-orm'
import * as schema from './tables'

/** -------------------- 表关系 -------------------- */
/** 按现有外键描述双向关系，查询只在显式 with 时加载关联，聚合和复杂分页仍按需使用 SQL */
export const runtimeRelations = defineRelations(schema, r => ({
  threads: {
    /** 线程的执行记录 */
    turns: r.many.turns({
      from: r.threads.id,
      to: r.turns.thread_id,
    }),
    /** 线程的 Provider 消息 */
    canonicalMessages: r.many.canonicalMessages({
      from: r.threads.id,
      to: r.canonicalMessages.thread_id,
    }),
    /** 线程的 UI 消息投影 */
    transcriptMessages: r.many.transcriptMessages({
      from: r.threads.id,
      to: r.transcriptMessages.thread_id,
    }),
    /** 线程归档的内容与资源 */
    artifacts: r.many.artifacts({
      from: r.threads.id,
      to: r.artifacts.thread_id,
    }),
    /** 当前线程的来源关系，根线程不存在此关系 */
    parentSpawnEdge: r.one.threadSpawnEdges({
      from: r.threads.id,
      to: r.threadSpawnEdges.child_thread_id,
    }),
    /** 当前线程派生的子线程关系 */
    childSpawnEdges: r.many.threadSpawnEdges({
      from: r.threads.id,
      to: r.threadSpawnEdges.parent_thread_id,
    }),
  },
  turns: {
    /** 执行所属线程 */
    thread: r.one.threads({
      from: r.turns.thread_id,
      to: r.threads.id,
      optional: false,
    }),
    /** 执行中的 Provider sampling 记录 */
    steps: r.many.steps({
      from: r.turns.id,
      to: r.steps.turn_id,
    }),
    /** 本次执行产生的 Provider 消息 */
    canonicalMessages: r.many.canonicalMessages({
      from: r.turns.id,
      to: r.canonicalMessages.turn_id,
    }),
    /** 本次执行的 UI 消息投影 */
    transcriptMessages: r.many.transcriptMessages({
      from: r.turns.id,
      to: r.transcriptMessages.turn_id,
    }),
    /** 本次执行的工具调用 */
    toolCalls: r.many.toolCalls({
      from: r.turns.id,
      to: r.toolCalls.turn_id,
    }),
    /** 本次执行的来源关系，普通 Turn 不存在此关系 */
    spawnEdge: r.one.turnSpawnEdges({
      from: r.turns.id,
      to: r.turnSpawnEdges.child_turn_id,
    }),
  },
  steps: {
    /** Step 所属执行 */
    turn: r.one.turns({
      from: r.steps.turn_id,
      to: r.turns.id,
      optional: false,
    }),
  },
  canonicalMessages: {
    /** 消息所属线程 */
    thread: r.one.threads({
      from: r.canonicalMessages.thread_id,
      to: r.threads.id,
      optional: false,
    }),
    /** 产生消息的执行 */
    turn: r.one.turns({
      from: r.canonicalMessages.turn_id,
      to: r.turns.id,
      optional: false,
    }),
    /** 消息的原文片段，仅在显式请求时加载 */
    parts: r.many.canonicalParts({
      from: r.canonicalMessages.id,
      to: r.canonicalParts.message_id,
    }),
  },
  canonicalParts: {
    /** 片段所属 Provider 消息 */
    message: r.one.canonicalMessages({
      from: r.canonicalParts.message_id,
      to: r.canonicalMessages.id,
      optional: false,
    }),
    /** 引用该片段作为结果的工具调用，数据库未限制为单个调用 */
    resultToolCalls: r.many.toolCalls({
      from: r.canonicalParts.id,
      to: r.toolCalls.result_part_id,
    }),
  },
  transcriptMessages: {
    /** 消息投影所属线程 */
    thread: r.one.threads({
      from: r.transcriptMessages.thread_id,
      to: r.threads.id,
      optional: false,
    }),
    /** 消息投影所属执行 */
    turn: r.one.turns({
      from: r.transcriptMessages.turn_id,
      to: r.turns.id,
      optional: false,
    }),
    /** 以该助手消息定位的工具调用 */
    toolCalls: r.many.toolCalls({
      from: r.transcriptMessages.id,
      to: r.toolCalls.assistant_message_id,
    }),
  },
  toolCalls: {
    /** 工具调用所属执行 */
    turn: r.one.turns({
      from: r.toolCalls.turn_id,
      to: r.turns.id,
      optional: false,
    }),
    /** 定位工具调用的 UI 助手消息，并非 Canonical Message */
    assistantMessage: r.one.transcriptMessages({
      from: r.toolCalls.assistant_message_id,
      to: r.transcriptMessages.id,
      optional: false,
    }),
    /** 可空的 Canonical 结果片段 */
    resultPart: r.one.canonicalParts({
      from: r.toolCalls.result_part_id,
      to: r.canonicalParts.id,
    }),
    /** 工具调用派生的 Turn 关系，唯一索引保证至多一条 */
    spawnEdge: r.one.turnSpawnEdges({
      from: r.toolCalls.id,
      to: r.turnSpawnEdges.parent_tool_call_id,
    }),
  },
  threadSpawnEdges: {
    /** 发起派生的父线程 */
    parentThread: r.one.threads({
      from: r.threadSpawnEdges.parent_thread_id,
      to: r.threads.id,
      optional: false,
    }),
    /** 被派生的子线程 */
    childThread: r.one.threads({
      from: r.threadSpawnEdges.child_thread_id,
      to: r.threads.id,
      optional: false,
    }),
  },
  turnSpawnEdges: {
    /** 被派生的子 Turn */
    childTurn: r.one.turns({
      from: r.turnSpawnEdges.child_turn_id,
      to: r.turns.id,
      optional: false,
    }),
    /** 发起该子 Turn 的父工具调用 */
    parentToolCall: r.one.toolCalls({
      from: r.turnSpawnEdges.parent_tool_call_id,
      to: r.toolCalls.id,
      optional: false,
    }),
  },
  artifacts: {
    /** 归档内容所属线程 */
    thread: r.one.threads({
      from: r.artifacts.thread_id,
      to: r.threads.id,
      optional: false,
    }),
  },
}))
