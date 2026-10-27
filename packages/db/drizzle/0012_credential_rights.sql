CREATE TABLE "credential_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid,
	"connection_id" uuid,
	"user_id" uuid,
	"team_id" uuid,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_grants_one_credential" CHECK ((secret_id IS NULL) <> (connection_id IS NULL)),
	CONSTRAINT "credential_grants_one_subject" CHECK ((user_id IS NULL) <> (team_id IS NULL)),
	CONSTRAINT "credential_grants_role" CHECK ("credential_grants"."role" IN ('use', 'manage'))
);
--> statement-breakpoint
CREATE TABLE "credential_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid,
	"connection_id" uuid,
	"project_id" uuid NOT NULL,
	"offered_by" uuid,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_shares_one_credential" CHECK ((secret_id IS NULL) <> (connection_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "deployment_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"secret_id" uuid,
	"connection_id" uuid,
	"share_id" uuid,
	CONSTRAINT "deployment_credentials_one_credential" CHECK ((secret_id IS NULL) <> (connection_id IS NULL))
);
--> statement-breakpoint
DROP INDEX "environment_connections_environment_name_unique";--> statement-breakpoint
ALTER TABLE "environment_connections" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_secret_id_environment_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."environment_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_connection_id_environment_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."environment_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_secret_id_environment_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."environment_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_connection_id_environment_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."environment_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_offered_by_auth_users_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_accepted_by_auth_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_credentials" ADD CONSTRAINT "deployment_credentials_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_credentials" ADD CONSTRAINT "deployment_credentials_secret_id_environment_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."environment_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_credentials" ADD CONSTRAINT "deployment_credentials_connection_id_environment_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."environment_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_credentials" ADD CONSTRAINT "deployment_credentials_share_id_credential_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."credential_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_secret_user_unique" ON "credential_grants" USING btree ("secret_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_secret_team_unique" ON "credential_grants" USING btree ("secret_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_connection_user_unique" ON "credential_grants" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_grants_connection_team_unique" ON "credential_grants" USING btree ("connection_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_shares_secret_project_unique" ON "credential_shares" USING btree ("secret_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_shares_connection_project_unique" ON "credential_shares" USING btree ("connection_id","project_id");--> statement-breakpoint
CREATE INDEX "credential_shares_project_idx" ON "credential_shares" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "deployment_credentials_deployment_idx" ON "deployment_credentials" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_credentials_secret_idx" ON "deployment_credentials" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "deployment_credentials_connection_idx" ON "deployment_credentials" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "environment_connections" ADD CONSTRAINT "environment_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_connections_project_environment_name_unique" ON "environment_connections" USING btree ("project_id","environment","name");