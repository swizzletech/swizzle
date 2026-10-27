CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" varchar(24) NOT NULL,
	"actor_id" uuid,
	"actor_label" varchar(320),
	"actor_role" varchar(16),
	"token_id" uuid,
	"action" varchar(200) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_id" uuid,
	"automation_id" uuid,
	"automation_slug" varchar(120),
	"run_id" uuid,
	"environment" varchar(32),
	"privileged" boolean DEFAULT false NOT NULL,
	"status" integer,
	"details" jsonb,
	"request_id" varchar(64) NOT NULL,
	"read_day" date,
	CONSTRAINT "audit_events_actor_kind" CHECK ("audit_events"."actor_kind" IN ('person', 'service-account', 'link', 'open'))
);
--> statement-breakpoint
ALTER TABLE "notification_rules" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "wait_assignee" jsonb;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_project_idx" ON "audit_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_automation_idx" ON "audit_events" USING btree ("automation_slug","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_privileged_read_unique" ON "audit_events" USING btree ("actor_id","project_id","read_day") WHERE "audit_events"."read_day" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_rules_project_idx" ON "notification_rules" USING btree ("project_id","environment");--> statement-breakpoint
CREATE INDEX "notification_rules_user_idx" ON "notification_rules" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_approver";