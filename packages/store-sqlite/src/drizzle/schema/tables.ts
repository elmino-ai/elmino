import type {
  ApprovalMode,
  RuntimeArtifactContentKind,
  RuntimeArtifactState,
  RuntimeArtifactStorage,
  RuntimeCanonicalPartType,
  RuntimeCanonicalRole,
  RuntimeStepStatus,
  RuntimeThreadLifecycle,
  RuntimeToolCallStatus,
  RuntimeToolDecision,
  SubagentMode,
  ThreadStatus,
  ThreadTurnStatus,
} from '@elmino/store'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  blob as sqliteBlob,
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** -------------------- 核心表 -------------------- */
/** 线程索引和稳定展示元信息 */
export const threads = sqliteTable('threads', {
  id: sqliteText('id').primaryKey(),
  dir: sqliteText('dir').notNull(),
  lifecycle: sqliteText('lifecycle').$type<RuntimeThreadLifecycle>().notNull().default('active'),
  agent_id: sqliteText('agent_id').notNull(),
  auto_title: sqliteText('auto_title'),
  user_title: sqliteText('user_title'),
  status: sqliteText('status').$type<ThreadStatus>().notNull(),
  pinned: sqliteInteger('pinned', { mode: 'boolean' }).notNull().default(false),
  unread_at: sqliteText('unread_at'),
  archived_at: sqliteText('archived_at'),
  created_at: sqliteText('created_at').notNull(),
  updated_at: sqliteText('updated_at').notNull(),
  last_interaction_at: sqliteText('last_interaction_at').notNull(),
  metadata_json: sqliteText('metadata_json').notNull().default('{}'),
  settings_json: sqliteText('settings_json').notNull(),
  state_json: sqliteText('state_json').notNull().default('{}'),
}, table => [
  check(
    'threads_status_check',
    sql`${table.status} IN ('idle', 'running', 'completed', 'failed', 'interrupted')`,
  ),
  check(
    'threads_lifecycle_check',
    sql`${table.lifecycle} IN ('active', 'deleting')`,
  ),
  check('threads_metadata_json_check', sql`json_valid(${table.metadata_json})`),
  check('threads_settings_json_check', sql`json_valid(${table.settings_json})`),
  check('threads_state_json_check', sql`json_valid(${table.state_json})`),
  index('idx_threads_active_list')
    .on(table.pinned, table.last_interaction_at, table.updated_at, table.id)
    .where(sql`${table.archived_at} IS NULL AND ${table.lifecycle} = 'active'`),
  index('idx_threads_archived_list')
    .on(table.archived_at, table.id)
    .where(sql`${table.archived_at} IS NOT NULL AND ${table.lifecycle} = 'active'`),
  index('idx_threads_running_roots')
    .on(table.status, table.id)
    .where(sql`${table.archived_at} IS NULL AND ${table.status} = 'running' AND ${table.lifecycle} = 'active'`),
])

/** 每次 Loop 执行的稳定 Turn 事实 */
export const turns = sqliteTable('turns', {
  id: sqliteText('id').primaryKey(),
  thread_id: sqliteText('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  status: sqliteText('status').$type<ThreadTurnStatus>().notNull(),
  model_config_json: sqliteText('model_config_json').notNull(),
  subagent_role_json: sqliteText('subagent_role_json').notNull(),
  subagent_roles_json: sqliteText('subagent_roles_json').notNull(),
  agent_snapshot_json: sqliteText('agent_snapshot_json').notNull(),
  approval_mode: sqliteText('approval_mode').$type<ApprovalMode>().notNull(),
  subagent_mode: sqliteText('subagent_mode').$type<SubagentMode>().notNull(),
  created_at: sqliteText('created_at').notNull(),
  updated_at: sqliteText('updated_at').notNull(),
  started_at: sqliteText('started_at'),
  ended_at: sqliteText('ended_at'),
  error_message: sqliteText('error_message'),
  interrupt_json: sqliteText('interrupt_json'),
}, table => [
  check(
    'turns_status_check',
    sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')`,
  ),
  check('turns_model_config_json_check', sql`json_valid(${table.model_config_json})`),
  check('turns_subagent_role_json_check', sql`json_valid(${table.subagent_role_json})`),
  check('turns_subagent_roles_json_check', sql`json_valid(${table.subagent_roles_json})`),
  check('turns_agent_snapshot_json_check', sql`json_valid(${table.agent_snapshot_json})`),
  check(
    'turns_approval_mode_check',
    sql`${table.approval_mode} IN ('auto', 'fullAccess', 'request')`,
  ),
  check(
    'turns_subagent_mode_check',
    sql`${table.subagent_mode} IN ('explicitOnly', 'proactive')`,
  ),
  check(
    'turns_interrupt_json_check',
    sql`${table.interrupt_json} IS NULL OR json_valid(${table.interrupt_json})`,
  ),
  index('idx_turns_thread_latest').on(table.thread_id, table.created_at, table.id),
])

/** Turn 内每次 Provider sampling 的 Step 事实 */
export const steps = sqliteTable('steps', {
  id: sqliteText('id').primaryKey(),
  turn_id: sqliteText('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  status: sqliteText('status').$type<RuntimeStepStatus>().notNull(),
  input: sqliteInteger('input').notNull(),
  output: sqliteInteger('output').notNull(),
  reasoning: sqliteInteger('reasoning').notNull(),
  cache_write: sqliteInteger('cache_write').notNull(),
  cache_read: sqliteInteger('cache_read').notNull(),
  estimated: sqliteInteger('estimated').notNull(),
  created_at: sqliteText('created_at').notNull(),
  ended_at: sqliteText('ended_at'),
}, table => [
  check(
    'steps_status_check',
    sql`${table.status} IN ('running', 'completed', 'failed', 'interrupted')`,
  ),
  check('steps_input_check', sql`${table.input} >= 0`),
  check('steps_output_check', sql`${table.output} >= 0`),
  check('steps_reasoning_check', sql`${table.reasoning} >= 0`),
  check(
    'steps_cache_write_check',
    sql`${table.cache_write} >= 0`,
  ),
  check(
    'steps_cache_read_check',
    sql`${table.cache_read} >= 0`,
  ),
  check('steps_estimated_check', sql`${table.estimated} >= 0`),
  index('idx_steps_turn_created').on(table.turn_id, table.created_at),
])

/** Provider 上下文的不可变消息事实 */
export const canonicalMessages = sqliteTable('canonical_messages', {
  id: sqliteText('id').primaryKey(),
  thread_id: sqliteText('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  turn_id: sqliteText('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  seq: sqliteInteger('seq').notNull(),
  role: sqliteText('role').$type<RuntimeCanonicalRole>().notNull(),
  provider_id: sqliteText('provider_id'),
  finish_reason: sqliteText('finish_reason'),
  raw_finish_reason: sqliteText('raw_finish_reason'),
  metadata_json: sqliteText('metadata_json').notNull().default('{}'),
  created_at: sqliteText('created_at').notNull(),
}, table => [
  check(
    'canonical_messages_role_check',
    sql`${table.role} IN ('user', 'assistant', 'tool', 'system')`,
  ),
  check('canonical_messages_metadata_json_check', sql`json_valid(${table.metadata_json})`),
  uniqueIndex('idx_canonical_messages_thread_seq').on(table.thread_id, table.seq),
  index('idx_canonical_messages_turn').on(table.turn_id, table.seq),
])

/** Canonical Message 的 Provider 原文 BLOB */
export const canonicalParts = sqliteTable('canonical_parts', {
  id: sqliteText('id').primaryKey(),
  message_id: sqliteText('message_id').notNull().references(() => canonicalMessages.id, { onDelete: 'cascade' }),
  seq: sqliteInteger('seq').notNull(),
  type: sqliteText('type').$type<RuntimeCanonicalPartType>().notNull(),
  size_bytes: sqliteInteger('size_bytes').notNull(),
  content_blob: sqliteBlob('content_blob', { mode: 'buffer' }).notNull(),
  created_at: sqliteText('created_at').notNull(),
}, table => [
  check(
    'canonical_parts_type_check',
    sql`${table.type} IN ('text', 'reasoning', 'image', 'document', 'tool-call', 'tool-result')`,
  ),
  check('canonical_parts_size_bytes_check', sql`${table.size_bytes} >= 0`),
  uniqueIndex('idx_canonical_parts_message_seq').on(table.message_id, table.seq),
])

/** 完整 UI transcript 消息投影 */
export const transcriptMessages = sqliteTable('transcript_messages', {
  id: sqliteText('id').primaryKey(),
  thread_id: sqliteText('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  turn_id: sqliteText('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  seq: sqliteInteger('seq').notNull(),
  content_blob: sqliteBlob('content_blob', { mode: 'buffer' }).notNull(),
}, table => [
  uniqueIndex('idx_transcript_messages_thread_seq').on(table.thread_id, table.seq),
  index('idx_transcript_messages_turn').on(table.turn_id),
])

/** 工具执行事实，消息位置由稳定 transcript ID 锚定 */
export const toolCalls = sqliteTable('tool_calls', {
  id: sqliteText('id').primaryKey(),
  turn_id: sqliteText('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  assistant_message_id: sqliteText('assistant_message_id').notNull().references(
    () => transcriptMessages.id,
    { onDelete: 'cascade' },
  ),
  assistant_part_id: sqliteText('assistant_part_id').notNull(),
  provider_call_id: sqliteText('provider_call_id').notNull(),
  name: sqliteText('name').notNull(),
  args_json: sqliteText('args_json').notNull(),
  status: sqliteText('status').$type<RuntimeToolCallStatus>().notNull(),
  decision: sqliteText('decision').$type<RuntimeToolDecision>(),
  started_at: sqliteText('started_at'),
  completed_at: sqliteText('completed_at'),
  error_message: sqliteText('error_message'),
  result_part_id: sqliteText('result_part_id').references(() => canonicalParts.id),
}, table => [
  check(
    'tool_calls_status_check',
    sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'skipped')`,
  ),
  check(
    'tool_calls_decision_check',
    sql`${table.decision} IS NULL OR ${table.decision} IN ('auto', 'approve', 'reject', 'edit', 'respond')`,
  ),
  check('tool_calls_args_json_check', sql`json_valid(${table.args_json})`),
  uniqueIndex('idx_tool_calls_part').on(table.assistant_part_id),
  uniqueIndex('idx_tool_calls_provider_call').on(table.turn_id, table.provider_call_id),
  index('idx_tool_calls_turn_started').on(table.turn_id, table.started_at),
])

/** 子线程与父线程的稳定派生关系 */
export const threadSpawnEdges = sqliteTable('thread_spawn_edges', {
  child_thread_id: sqliteText('child_thread_id').primaryKey().references(() => threads.id, { onDelete: 'cascade' }),
  parent_thread_id: sqliteText('parent_thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  owner_id: sqliteText('owner_id').notNull(),
  created_at: sqliteText('created_at').notNull(),
}, table => [
  index('idx_thread_spawn_parent').on(table.parent_thread_id, table.created_at),
])

/** 子线程 Turn 与父工具调用的派生关系 */
export const turnSpawnEdges = sqliteTable('turn_spawn_edges', {
  child_turn_id: sqliteText('child_turn_id').primaryKey().references(() => turns.id, { onDelete: 'cascade' }),
  parent_tool_call_id: sqliteText('parent_tool_call_id')
    .notNull()
    .references(() => toolCalls.id, { onDelete: 'cascade' }),
  created_at: sqliteText('created_at').notNull(),
}, table => [
  uniqueIndex('idx_turn_spawn_parent_tool').on(table.parent_tool_call_id),
])

/** 大内容与外部资源归档 */
export const artifacts = sqliteTable('artifacts', {
  id: sqliteText('id').primaryKey(),
  thread_id: sqliteText('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  storage: sqliteText('storage').$type<RuntimeArtifactStorage>().notNull(),
  content_kind: sqliteText('content_kind').$type<RuntimeArtifactContentKind>().notNull(),
  inline_text: sqliteText('inline_text'),
  inline_json: sqliteText('inline_json'),
  blob_key: sqliteText('blob_key'),
  uri: sqliteText('uri'),
  mime_type: sqliteText('mime_type'),
  encoding: sqliteText('encoding'),
  size_bytes: sqliteInteger('size_bytes'),
  sha256: sqliteText('sha256'),
  preview_text: sqliteText('preview_text'),
  state: sqliteText('state').$type<RuntimeArtifactState>().notNull(),
  missing_at: sqliteText('missing_at'),
  created_at: sqliteText('created_at').notNull(),
  updated_at: sqliteText('updated_at').notNull(),
  metadata_json: sqliteText('metadata_json').notNull().default('{}'),
}, table => [
  check('artifacts_storage_check', sql`${table.storage} IN ('inline', 'blob')`),
  check('artifacts_content_kind_check', sql`${table.content_kind} IN ('text', 'json', 'bytes')`),
  check('artifacts_state_check', sql`${table.state} IN ('available', 'missing', 'pending')`),
  check(
    'artifacts_inline_json_check',
    sql`${table.inline_json} IS NULL OR json_valid(${table.inline_json})`,
  ),
  check('artifacts_metadata_json_check', sql`json_valid(${table.metadata_json})`),
  index('idx_artifacts_thread').on(table.thread_id),
])
