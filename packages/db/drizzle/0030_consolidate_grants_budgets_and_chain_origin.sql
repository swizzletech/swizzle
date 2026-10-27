CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"on" varchar(16) NOT NULL,
	"project_id" uuid NOT NULL,
	"automation_id" uuid,
	"environment" varchar(32),
	"user_id" uuid,
	"team_id" uuid,
	"service_account_id" uuid,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_target_subject_unique" UNIQUE NULLS NOT DISTINCT("on","project_id","automation_id","environment","user_id","team_id","service_account_id"),
	CONSTRAINT "grants_one_subject" CHECK (num_nonnulls(user_id, team_id, service_account_id) = 1),
	CONSTRAINT "grants_role" CHECK ("grants"."role" IN ('viewer', 'operator', 'editor', 'admin')),
	CONSTRAINT "grants_target" CHECK (("grants"."on" = 'project' AND "grants"."automation_id" IS NULL AND "grants"."environment" IS NULL)
    OR ("grants"."on" = 'automation' AND "grants"."automation_id" IS NOT NULL AND "grants"."environment" IS NULL)
    OR ("grants"."on" = 'environment' AND "grants"."automation_id" IS NULL AND "grants"."environment" IS NOT NULL)),
	CONSTRAINT "grants_admin" CHECK ("grants"."role" <> 'admin' OR ("grants"."on" = 'project' AND "grants"."service_account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "worker_grants" (
	"worker_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	CONSTRAINT "worker_grants_worker_id_project_id_environment_pk" PRIMARY KEY("worker_id","project_id","environment")
);
--> statement-breakpoint
ALTER TABLE "automation_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "environment_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_enrollment_budgets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "automation_grants" CASCADE;--> statement-breakpoint
DROP TABLE "environment_grants" CASCADE;--> statement-breakpoint
DROP TABLE "project_grants" CASCADE;--> statement-breakpoint
DROP TABLE "worker_enrollment_budgets" CASCADE;--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "chain_source_run_id" TO "chain_origin_run_id";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_chain_source_run_id_runs_id_fk";
--> statement-breakpoint
DROP INDEX "runs_chain_source_run_idx";--> statement-breakpoint
DROP INDEX "runs_chain_source_succeeded_idx";--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_protected_fk" FOREIGN KEY ("project_id","environment") REFERENCES "public"."protected_environments"("project_id","environment") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_grants" ADD CONSTRAINT "worker_grants_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_grants" ADD CONSTRAINT "worker_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_chain_origin_run_id_runs_id_fk" FOREIGN KEY ("chain_origin_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_chain_source_run_idx" ON "runs" USING btree ("chain_origin_run_id");--> statement-breakpoint
CREATE INDEX "runs_chain_source_succeeded_idx" ON "runs" USING btree ("automation_id","chain_origin_run_id","status","finished_at");--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "environments";
--> statement-breakpoint
INSERT INTO "grants" ("on", "project_id", "environment", "team_id", "role")
SELECT 'environment', "project_id", "environment", '00000000-0000-4000-8000-000000000002', 'editor'
FROM "protected_environments"
WHERE "project_id" = '00000000-0000-4000-8000-000000000001' AND "environment" = 'production'
  AND EXISTS (SELECT 1 FROM "teams" WHERE "id" = '00000000-0000-4000-8000-000000000002');
