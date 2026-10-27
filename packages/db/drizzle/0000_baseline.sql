CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"normalized_name" varchar(80) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_state" (
	"automation_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_timeout_grant_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_timeout_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"max_timeout_ms" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_timeout_grants_max_timeout_ms_positive" CHECK ("automation_timeout_grants"."max_timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "automation_trigger_chain_sources" (
	"trigger_id" uuid NOT NULL,
	"source_automation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"trigger_type" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"webhook_path" varchar(255),
	"cron_schedule" varchar(255),
	"cron_interval_ms" integer,
	"chain_source_automation_id" uuid,
	"chain_on_status" varchar(32),
	"chain_payload_mode" varchar(32),
	"next_run_at" timestamp with time zone,
	"error_code" varchar(64),
	"error_message" text,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" varchar(64) NOT NULL,
	"entrypoint" varchar(255) NOT NULL,
	"source_hash" varchar(128) NOT NULL,
	"config_hash" varchar(64) NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"folder_id" uuid,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_join_fires" (
	"trigger_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_auth_rate_limits" (
	"key_hash" varchar(64) PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_second_factors" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_algorithm" varchar(32) NOT NULL,
	"secret_key_version" varchar(32) NOT NULL,
	"last_used_step" integer DEFAULT 0 NOT NULL,
	"enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dashboard_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"first_name" varchar(80) NOT NULL,
	"last_name" varchar(80) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(24) DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployment_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"previous_deployment_id" uuid,
	"environment" varchar(32) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"version" varchar(64) NOT NULL,
	"source_hash" varchar(128) NOT NULL,
	"previous_version" varchar(64),
	"previous_source_hash" varchar(128),
	"diff" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"version_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"artifact_root_path" varchar(512) NOT NULL,
	"artifact_backend" varchar(32) NOT NULL,
	"artifact_locator" jsonb NOT NULL,
	"manifest_path" varchar(512) NOT NULL,
	"source_directory" varchar(512) NOT NULL,
	"runtime_snapshot" jsonb NOT NULL,
	"build_snapshot" jsonb NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_config" jsonb,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text NOT NULL,
	"client_secret_algorithm" varchar(32) NOT NULL,
	"client_secret_key_version" varchar(32) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"token_ciphertext" text,
	"token_algorithm" varchar(32),
	"token_key_version" varchar(32),
	"token_version" integer DEFAULT 0 NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_error_at" timestamp with time zone,
	"pending_state_hash" varchar(64),
	"pending_code_verifier_ciphertext" text,
	"pending_redirect_uri" text,
	"pending_scopes" jsonb,
	"pending_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"ciphertext" text NOT NULL,
	"algorithm" varchar(32) NOT NULL,
	"key_version" varchar(32) NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"automation_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"channel" varchar(32) DEFAULT 'telegram' NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"chat_id" varchar(120) NOT NULL,
	"run_id" uuid,
	"dedupe_key" varchar(255) NOT NULL,
	"status" varchar(32) NOT NULL,
	"provider_message_id" varchar(120),
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid,
	"environment" varchar(32) NOT NULL,
	"channel" varchar(32) DEFAULT 'telegram' NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"chat_id" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" integer DEFAULT 1 NOT NULL,
	"window_seconds" integer DEFAULT 3600 NOT NULL,
	"cooldown_seconds" integer DEFAULT 900 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_environments" (
	"name" varchar(32) PRIMARY KEY NOT NULL,
	"display_name" varchar(80),
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_metric_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(32) NOT NULL,
	"queue_name" varchar(120) NOT NULL,
	"active" integer DEFAULT 0 NOT NULL,
	"waiting" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"delayed" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_attempt_connection_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"environment" varchar(32) NOT NULL,
	"connection_name" varchar(120) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"token_version" integer NOT NULL,
	"injected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_attempt_secret_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"environment" varchar(32) NOT NULL,
	"secret_name" varchar(120) NOT NULL,
	"secret_version" integer NOT NULL,
	"algorithm" varchar(32) NOT NULL,
	"key_version" varchar(32) NOT NULL,
	"injected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"queue_job_id" varchar(120) NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"error_code" varchar(64),
	"error_message" text,
	"error_stack" text,
	"error_cause" text,
	"error_classification" varchar(32),
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" varchar(255) NOT NULL,
	"attempt_number" integer NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"trigger_type" varchar(32) NOT NULL,
	"queue_name" varchar(120) NOT NULL,
	"queue_job_id" varchar(120) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"webhook_context" jsonb,
	"result" jsonb,
	"wait_reason" varchar(32),
	"wait_key" varchar(255),
	"wait_until" timestamp with time zone,
	"parent_run_id" uuid,
	"parent_step_key" varchar(255),
	"invoke_depth" integer DEFAULT 0 NOT NULL,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"chain_source_run_id" uuid,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"attempts_max" integer NOT NULL,
	"attempts_made" integer DEFAULT 0 NOT NULL,
	"last_attempt_number" integer,
	"error_code" varchar(64),
	"error_message" text,
	"error_stack" text,
	"error_cause" text,
	"error_classification" varchar(32),
	"dead_letter_reason" varchar(64),
	"correlation_id" varchar(128),
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" varchar(32) NOT NULL,
	"instance_id" varchar(120) NOT NULL,
	"environment" varchar(32) NOT NULL,
	"host" varchar(255),
	"pid" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"run_id" uuid,
	"environment" varchar(32) NOT NULL,
	"trigger_type" varchar(32) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_state" ADD CONSTRAINT "automation_state_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_timeout_grant_audit_events" ADD CONSTRAINT "automation_timeout_grant_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_timeout_grants" ADD CONSTRAINT "automation_timeout_grants_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_trigger_chain_sources" ADD CONSTRAINT "automation_trigger_chain_sources_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_trigger_chain_sources" ADD CONSTRAINT "automation_trigger_chain_sources_source_automation_id_automations_id_fk" FOREIGN KEY ("source_automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_version_id_automation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_chain_source_automation_id_automations_id_fk" FOREIGN KEY ("chain_source_automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_folder_id_automation_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."automation_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_join_fires" ADD CONSTRAINT "chain_join_fires_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_join_fires" ADD CONSTRAINT "chain_join_fires_origin_run_id_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_join_fires" ADD CONSTRAINT "chain_join_fires_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_devices" ADD CONSTRAINT "dashboard_devices_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_recovery_codes" ADD CONSTRAINT "dashboard_recovery_codes_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_second_factors" ADD CONSTRAINT "dashboard_second_factors_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_previous_deployment_id_deployments_id_fk" FOREIGN KEY ("previous_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_version_id_automation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempt_connection_usages" ADD CONSTRAINT "run_attempt_connection_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempt_secret_usages" ADD CONSTRAINT "run_attempt_secret_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_version_id_automation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_chain_source_run_id_runs_id_fk" FOREIGN KEY ("chain_source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_name_unique" ON "api_tokens" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_unique" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_folders_name_unique" ON "automation_folders" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "automation_folders_sort_idx" ON "automation_folders" USING btree ("sort_order","name");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_state_pk" ON "automation_state" USING btree ("automation_id","environment","key");--> statement-breakpoint
CREATE INDEX "automation_state_automation_environment_idx" ON "automation_state" USING btree ("automation_id","environment","updated_at");--> statement-breakpoint
CREATE INDEX "automation_timeout_grant_audit_events_automation_occurred_idx" ON "automation_timeout_grant_audit_events" USING btree ("automation_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_timeout_grants_automation_environment_unique" ON "automation_timeout_grants" USING btree ("automation_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_trigger_chain_sources_unique" ON "automation_trigger_chain_sources" USING btree ("trigger_id","source_automation_id");--> statement-breakpoint
CREATE INDEX "automation_trigger_chain_sources_source_idx" ON "automation_trigger_chain_sources" USING btree ("source_automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_triggers_automation_environment_unique" ON "automation_triggers" USING btree ("automation_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_triggers_webhook_path_unique" ON "automation_triggers" USING btree ("environment","webhook_path");--> statement-breakpoint
CREATE INDEX "automation_triggers_status_next_run_idx" ON "automation_triggers" USING btree ("trigger_type","status","environment","next_run_at");--> statement-breakpoint
CREATE INDEX "automation_triggers_chain_source_idx" ON "automation_triggers" USING btree ("chain_source_automation_id","environment","status");--> statement-breakpoint
CREATE INDEX "automation_versions_automation_created_idx" ON "automation_versions" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_source_unique" ON "automation_versions" USING btree ("automation_id","version","source_hash","config_hash");--> statement-breakpoint
CREATE INDEX "automations_folder_idx" ON "automations" USING btree ("folder_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_slug_unique" ON "automations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_join_fires_trigger_origin_unique" ON "chain_join_fires" USING btree ("trigger_id","origin_run_id");--> statement-breakpoint
CREATE INDEX "chain_join_fires_run_idx" ON "chain_join_fires" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "dashboard_auth_rate_limits_expiry_idx" ON "dashboard_auth_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_devices_token_hash_unique" ON "dashboard_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_recovery_codes_hash_unique" ON "dashboard_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_sessions_token_hash_unique" ON "dashboard_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "dashboard_sessions_user_expiry_idx" ON "dashboard_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_users_email_unique" ON "dashboard_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_users_single_owner_unique" ON "dashboard_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "deployment_audit_events_automation_occurred_idx" ON "deployment_audit_events" USING btree ("automation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "deployment_audit_events_deployment_idx" ON "deployment_audit_events" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployments_automation_environment_idx" ON "deployments" USING btree ("automation_id","environment","status","deployed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_automation_seq_unique" ON "deployments" USING btree ("automation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_connections_environment_name_unique" ON "environment_connections" USING btree ("environment","name");--> statement-breakpoint
CREATE INDEX "environment_connections_environment_updated_idx" ON "environment_connections" USING btree ("environment","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_connections_pending_state_unique" ON "environment_connections" USING btree ("pending_state_hash") WHERE "environment_connections"."pending_state_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_secrets_environment_name_unique" ON "environment_secrets" USING btree ("environment","name");--> statement-breakpoint
CREATE INDEX "environment_secrets_environment_updated_idx" ON "environment_secrets" USING btree ("environment","updated_at");--> statement-breakpoint
CREATE INDEX "maintenance_runs_environment_started_idx" ON "maintenance_runs" USING btree ("environment","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_dedupe_unique" ON "notification_deliveries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_environment_created_idx" ON "notification_deliveries" USING btree ("environment","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_rule_created_idx" ON "notification_deliveries" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_rules_automation_event_idx" ON "notification_rules" USING btree ("automation_id","environment","event_type","enabled");--> statement-breakpoint
CREATE INDEX "queue_metric_samples_environment_observed_idx" ON "queue_metric_samples" USING btree ("environment","queue_name","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_attempt_connection_usages_attempt_connection_unique" ON "run_attempt_connection_usages" USING btree ("run_id","attempt_number","connection_name");--> statement-breakpoint
CREATE INDEX "run_attempt_connection_usages_run_attempt_idx" ON "run_attempt_connection_usages" USING btree ("run_id","attempt_number","injected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_attempt_secret_usages_attempt_secret_unique" ON "run_attempt_secret_usages" USING btree ("run_id","attempt_number","secret_name");--> statement-breakpoint
CREATE INDEX "run_attempt_secret_usages_run_attempt_idx" ON "run_attempt_secret_usages" USING btree ("run_id","attempt_number","injected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_attempts_run_attempt_unique" ON "run_attempts" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE INDEX "run_attempts_run_started_idx" ON "run_attempts" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "run_attempts_status_heartbeat_idx" ON "run_attempts" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "run_attempts_finished_at_idx" ON "run_attempts" USING btree ("finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_key_unique" ON "run_steps" USING btree ("run_id","step_key");--> statement-breakpoint
CREATE INDEX "run_steps_run_created_idx" ON "run_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_queue_job_unique" ON "runs" USING btree ("queue_job_id");--> statement-breakpoint
CREATE INDEX "runs_queued_at_idx" ON "runs" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "runs_status_queued_at_idx" ON "runs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "runs_automation_queued_at_idx" ON "runs" USING btree ("automation_id","queued_at");--> statement-breakpoint
CREATE INDEX "runs_finished_at_idx" ON "runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "runs_parent_run_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "runs_chain_source_run_idx" ON "runs" USING btree ("chain_source_run_id");--> statement-breakpoint
CREATE INDEX "runs_chain_source_succeeded_idx" ON "runs" USING btree ("automation_id","chain_source_run_id","status","finished_at");--> statement-breakpoint
CREATE INDEX "runs_status_wait_until_idx" ON "runs" USING btree ("status","wait_until");--> statement-breakpoint
CREATE UNIQUE INDEX "service_heartbeats_service_instance_unique" ON "service_heartbeats" USING btree ("service","instance_id");--> statement-breakpoint
CREATE INDEX "service_heartbeats_environment_observed_idx" ON "service_heartbeats" USING btree ("environment","service","observed_at");--> statement-breakpoint
CREATE INDEX "trigger_audit_events_trigger_occurred_idx" ON "trigger_audit_events" USING btree ("trigger_id","occurred_at");--> statement-breakpoint
CREATE INDEX "trigger_audit_events_automation_occurred_idx" ON "trigger_audit_events" USING btree ("automation_id","occurred_at");