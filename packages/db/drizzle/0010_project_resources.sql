ALTER TABLE "automation_timeout_grant_audit_events" DROP CONSTRAINT "automation_timeout_grant_audit_events_automation_id_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "deployment_audit_events" DROP CONSTRAINT "deployment_audit_events_automation_id_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_automation_id_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "trigger_audit_events" DROP CONSTRAINT "trigger_audit_events_trigger_id_automation_triggers_id_fk";
--> statement-breakpoint
ALTER TABLE "trigger_audit_events" DROP CONSTRAINT "trigger_audit_events_automation_id_automations_id_fk";
--> statement-breakpoint
DROP INDEX "environment_secrets_environment_name_unique";--> statement-breakpoint
DROP INDEX "automation_folders_name_unique";--> statement-breakpoint
DROP INDEX "automation_folders_sort_idx";--> statement-breakpoint
DROP INDEX "automations_slug_unique";--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_folders" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_timeout_grant_audit_events" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_secrets" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_folders" ADD CONSTRAINT "automation_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_timeout_grant_audit_events" ADD CONSTRAINT "automation_timeout_grant_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_timeout_grant_audit_events" ADD CONSTRAINT "automation_timeout_grant_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_secrets" ADD CONSTRAINT "environment_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" ADD CONSTRAINT "trigger_audit_events_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_secrets_project_environment_name_unique" ON "environment_secrets" USING btree ("project_id","environment","name");--> statement-breakpoint
CREATE INDEX "runs_project_queued_at_idx" ON "runs" USING btree ("project_id","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_folders_name_unique" ON "automation_folders" USING btree ("project_id","normalized_name");--> statement-breakpoint
CREATE INDEX "automation_folders_sort_idx" ON "automation_folders" USING btree ("project_id","sort_order","name");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_slug_unique" ON "automations" USING btree ("slug") WHERE "automations"."deleted_at" IS NULL;