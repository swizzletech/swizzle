CREATE TABLE "api_contacts" (
	"automation_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"host" varchar(255) NOT NULL,
	"last_contact_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_status" integer NOT NULL,
	"deprecated_at" timestamp with time zone,
	"sunset_at" timestamp with time zone,
	"notice_path" text,
	"notice_url" text,
	"notice_seen_at" timestamp with time zone,
	"notice_runs" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"entrypoint" varchar(255) NOT NULL,
	"every_ms" bigint NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_exit_code" integer,
	"last_output" text,
	"last_stderr_tail" text,
	"last_warning" text,
	"last_green_at" timestamp with time zone,
	"last_green_output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_contacts" ADD CONSTRAINT "api_contacts_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_checks" ADD CONSTRAINT "automation_checks_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_checks" ADD CONSTRAINT "automation_checks_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_checks" ADD CONSTRAINT "automation_checks_version_id_automation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_contacts_pk" ON "api_contacts" USING btree ("automation_id","environment","host");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_checks_automation_environment_unique" ON "automation_checks" USING btree ("automation_id","environment");--> statement-breakpoint
CREATE INDEX "automation_checks_environment_next_check_idx" ON "automation_checks" USING btree ("environment","next_check_at");