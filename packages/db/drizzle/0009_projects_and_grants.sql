CREATE TABLE "automation_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_grants_one_subject" CHECK ((user_id IS NULL) <> (team_id IS NULL)),
	CONSTRAINT "automation_grants_role" CHECK ("automation_grants"."role" IN ('viewer', 'operator', 'editor'))
);
--> statement-breakpoint
CREATE TABLE "environment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_grants_one_subject" CHECK ((user_id IS NULL) <> (team_id IS NULL)),
	CONSTRAINT "environment_grants_role" CHECK ("environment_grants"."role" IN ('viewer', 'operator', 'editor'))
);
--> statement-breakpoint
CREATE TABLE "project_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_grants_one_subject" CHECK ((user_id IS NULL) <> (team_id IS NULL)),
	CONSTRAINT "project_grants_role" CHECK ("project_grants"."role" IN ('viewer', 'operator', 'editor', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_environments" (
	"project_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protected_environments_project_id_environment_pk" PRIMARY KEY("project_id","environment")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"normalized_name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "api_tokens_name_unique";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "role" varchar(16) DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_grants" ADD CONSTRAINT "automation_grants_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_grants" ADD CONSTRAINT "automation_grants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_grants" ADD CONSTRAINT "automation_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_grants" ADD CONSTRAINT "environment_grants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_grants" ADD CONSTRAINT "environment_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_grants" ADD CONSTRAINT "environment_grants_protected_fk" FOREIGN KEY ("project_id","environment") REFERENCES "public"."protected_environments"("project_id","environment") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_environments" ADD CONSTRAINT "protected_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_grants_user_unique" ON "automation_grants" USING btree ("automation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_grants_team_unique" ON "automation_grants" USING btree ("automation_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_grants_user_unique" ON "environment_grants" USING btree ("project_id","environment","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_grants_team_unique" ON "environment_grants" USING btree ("project_id","environment","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_grants_user_unique" ON "project_grants" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_grants_team_unique" ON "project_grants" USING btree ("project_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_unique" ON "team_members" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_name_unique" ON "teams" USING btree ("normalized_name");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automations_project_idx" ON "automations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_name_unique" ON "api_tokens" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_role" CHECK ("auth_users"."role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
-- The project a fresh instance starts with (DEFAULT_PROJECT_ID in access.ts), production protected.
INSERT INTO "projects" ("id", "slug", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default');--> statement-breakpoint
INSERT INTO "protected_environments" ("project_id", "environment") VALUES ('00000000-0000-4000-8000-000000000001', 'production');
