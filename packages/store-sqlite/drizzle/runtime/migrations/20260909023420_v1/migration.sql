CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`storage` text NOT NULL,
	`content_kind` text NOT NULL,
	`inline_text` text,
	`inline_json` text,
	`blob_key` text,
	`uri` text,
	`mime_type` text,
	`encoding` text,
	`size_bytes` integer,
	`sha256` text,
	`preview_text` text,
	`state` text NOT NULL,
	`missing_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_artifacts_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT "artifacts_storage_check" CHECK("storage" IN ('inline', 'blob')),
	CONSTRAINT "artifacts_content_kind_check" CHECK("content_kind" IN ('text', 'json', 'bytes')),
	CONSTRAINT "artifacts_state_check" CHECK("state" IN ('available', 'missing', 'pending')),
	CONSTRAINT "artifacts_inline_json_check" CHECK("inline_json" IS NULL OR json_valid("inline_json")),
	CONSTRAINT "artifacts_metadata_json_check" CHECK(json_valid("metadata_json"))
);
--> statement-breakpoint
CREATE TABLE `canonical_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`provider_id` text,
	`finish_reason` text,
	`raw_finish_reason` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_canonical_messages_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_canonical_messages_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON DELETE CASCADE,
	CONSTRAINT "canonical_messages_role_check" CHECK("role" IN ('user', 'assistant', 'tool', 'system')),
	CONSTRAINT "canonical_messages_metadata_json_check" CHECK(json_valid("metadata_json"))
);
--> statement-breakpoint
CREATE TABLE `canonical_parts` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_blob` blob NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_canonical_parts_message_id_canonical_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `canonical_messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT "canonical_parts_type_check" CHECK("type" IN ('text', 'reasoning', 'image', 'document', 'tool-call', 'tool-result')),
	CONSTRAINT "canonical_parts_size_bytes_check" CHECK("size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`reasoning` integer NOT NULL,
	`cache_write` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`estimated` integer NOT NULL,
	`created_at` text NOT NULL,
	`ended_at` text,
	CONSTRAINT `fk_steps_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON DELETE CASCADE,
	CONSTRAINT "steps_status_check" CHECK("status" IN ('running', 'completed', 'failed', 'interrupted')),
	CONSTRAINT "steps_input_check" CHECK("input" >= 0),
	CONSTRAINT "steps_output_check" CHECK("output" >= 0),
	CONSTRAINT "steps_reasoning_check" CHECK("reasoning" >= 0),
	CONSTRAINT "steps_cache_write_check" CHECK("cache_write" >= 0),
	CONSTRAINT "steps_cache_read_check" CHECK("cache_read" >= 0),
	CONSTRAINT "steps_estimated_check" CHECK("estimated" >= 0)
);
--> statement-breakpoint
CREATE TABLE `thread_spawn_edges` (
	`child_thread_id` text PRIMARY KEY,
	`parent_thread_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_thread_spawn_edges_child_thread_id_threads_id_fk` FOREIGN KEY (`child_thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_thread_spawn_edges_parent_thread_id_threads_id_fk` FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY,
	`dir` text NOT NULL,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`agent_id` text NOT NULL,
	`auto_title` text,
	`user_title` text,
	`status` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`unread_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_interaction_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`settings_json` text NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "threads_status_check" CHECK("status" IN ('idle', 'running', 'completed', 'failed', 'interrupted')),
	CONSTRAINT "threads_lifecycle_check" CHECK("lifecycle" IN ('active', 'deleting')),
	CONSTRAINT "threads_metadata_json_check" CHECK(json_valid("metadata_json")),
	CONSTRAINT "threads_settings_json_check" CHECK(json_valid("settings_json")),
	CONSTRAINT "threads_state_json_check" CHECK(json_valid("state_json"))
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY,
	`turn_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`assistant_part_id` text NOT NULL,
	`provider_call_id` text NOT NULL,
	`name` text NOT NULL,
	`args_json` text NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`started_at` text,
	`completed_at` text,
	`error_message` text,
	`result_part_id` text,
	CONSTRAINT `fk_tool_calls_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tool_calls_assistant_message_id_transcript_messages_id_fk` FOREIGN KEY (`assistant_message_id`) REFERENCES `transcript_messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tool_calls_result_part_id_canonical_parts_id_fk` FOREIGN KEY (`result_part_id`) REFERENCES `canonical_parts`(`id`),
	CONSTRAINT "tool_calls_status_check" CHECK("status" IN ('pending', 'running', 'completed', 'failed', 'skipped')),
	CONSTRAINT "tool_calls_decision_check" CHECK("decision" IS NULL OR "decision" IN ('auto', 'approve', 'reject', 'edit', 'respond')),
	CONSTRAINT "tool_calls_args_json_check" CHECK(json_valid("args_json"))
);
--> statement-breakpoint
CREATE TABLE `transcript_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`seq` integer NOT NULL,
	`content_blob` blob NOT NULL,
	CONSTRAINT `fk_transcript_messages_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_transcript_messages_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `turn_spawn_edges` (
	`child_turn_id` text PRIMARY KEY,
	`parent_tool_call_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_turn_spawn_edges_child_turn_id_turns_id_fk` FOREIGN KEY (`child_turn_id`) REFERENCES `turns`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_turn_spawn_edges_parent_tool_call_id_tool_calls_id_fk` FOREIGN KEY (`parent_tool_call_id`) REFERENCES `tool_calls`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`model_config_json` text NOT NULL,
	`subagent_role_json` text NOT NULL,
	`subagent_roles_json` text NOT NULL,
	`agent_snapshot_json` text NOT NULL,
	`approval_mode` text NOT NULL,
	`subagent_mode` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`error_message` text,
	`interrupt_json` text,
	CONSTRAINT `fk_turns_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT "turns_status_check" CHECK("status" IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
	CONSTRAINT "turns_model_config_json_check" CHECK(json_valid("model_config_json")),
	CONSTRAINT "turns_subagent_role_json_check" CHECK(json_valid("subagent_role_json")),
	CONSTRAINT "turns_subagent_roles_json_check" CHECK(json_valid("subagent_roles_json")),
	CONSTRAINT "turns_agent_snapshot_json_check" CHECK(json_valid("agent_snapshot_json")),
	CONSTRAINT "turns_approval_mode_check" CHECK("approval_mode" IN ('auto', 'fullAccess', 'request')),
	CONSTRAINT "turns_subagent_mode_check" CHECK("subagent_mode" IN ('explicitOnly', 'proactive')),
	CONSTRAINT "turns_interrupt_json_check" CHECK("interrupt_json" IS NULL OR json_valid("interrupt_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_thread` ON `artifacts` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_canonical_messages_thread_seq` ON `canonical_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_canonical_messages_turn` ON `canonical_messages` (`turn_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_canonical_parts_message_seq` ON `canonical_parts` (`message_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_steps_turn_created` ON `steps` (`turn_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_thread_spawn_parent` ON `thread_spawn_edges` (`parent_thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_active_list` ON `threads` (`pinned`,`last_interaction_at`,`updated_at`,`id`) WHERE "threads"."archived_at" IS NULL AND "threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX `idx_threads_archived_list` ON `threads` (`archived_at`,`id`) WHERE "threads"."archived_at" IS NOT NULL AND "threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX `idx_threads_running_roots` ON `threads` (`status`,`id`) WHERE "threads"."archived_at" IS NULL AND "threads"."status" = 'running' AND "threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tool_calls_part` ON `tool_calls` (`assistant_part_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tool_calls_provider_call` ON `tool_calls` (`turn_id`,`provider_call_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_calls_turn_started` ON `tool_calls` (`turn_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transcript_messages_thread_seq` ON `transcript_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_transcript_messages_turn` ON `transcript_messages` (`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_turn_spawn_parent_tool` ON `turn_spawn_edges` (`parent_tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_turns_thread_latest` ON `turns` (`thread_id`,`created_at`,`id`);