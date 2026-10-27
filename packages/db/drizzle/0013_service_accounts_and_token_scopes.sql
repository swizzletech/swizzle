CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"normalized_name" varchar(80) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_grants" DROP CONSTRAINT "automation_grants_one_subject";--> statement-breakpoint
ALTER TABLE "credential_grants" DROP CONSTRAINT "credential_grants_one_subject";--> statement-breakpoint
ALTER TABLE "environment_grants" DROP CONSTRAINT "environment_grants_one_subject";--> statement-breakpoint
ALTER TABLE "project_grants" DROP CONSTRAINT "project_grants_one_subject";--> statement-breakpoint
DROP INDEX "api_tokens_name_unique";--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "role" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "environments" varchar(32)[];--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "issued_by" uuid;--> statement-breakpoint
ALTER TABLE "automation_grants" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_grants" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "project_grants" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_name_unique" ON "service_accounts" USING btree ("project_id","normalized_name");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_issued_by_auth_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_grants" ADD CONSTRAINT "automation_grants_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_grants" ADD CONSTRAINT "environment_grants_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_user_name_unique" ON "api_tokens" USING btree ("user_id","name") WHERE "api_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_service_account_name_unique" ON "api_tokens" USING btree ("service_account_id","name") WHERE "api_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_grants_service_account_unique" ON "automation_grants" USING btree ("automation_id","service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_secret_service_account_unique" ON "credential_grants" USING btree ("secret_id","service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_connection_service_account_unique" ON "credential_grants" USING btree ("connection_id","service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_grants_service_account_unique" ON "environment_grants" USING btree ("project_id","environment","service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_grants_service_account_unique" ON "project_grants" USING btree ("project_id","service_account_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_one_holder" CHECK ((user_id IS NULL) <> (service_account_id IS NULL));--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_role" CHECK ("api_tokens"."role" IN ('viewer', 'operator', 'editor', 'admin'));--> statement-breakpoint
ALTER TABLE "automation_grants" ADD CONSTRAINT "automation_grants_one_subject" CHECK (num_nonnulls(user_id, team_id, service_account_id) = 1);--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_one_subject" CHECK (num_nonnulls(user_id, team_id, service_account_id) = 1);--> statement-breakpoint
ALTER TABLE "environment_grants" ADD CONSTRAINT "environment_grants_one_subject" CHECK (num_nonnulls(user_id, team_id, service_account_id) = 1);--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_service_account_role" CHECK ("project_grants"."service_account_id" IS NULL OR "project_grants"."role" <> 'admin');--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_one_subject" CHECK (num_nonnulls(user_id, team_id, service_account_id) = 1);