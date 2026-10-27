CREATE TABLE "worker_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"action" text NOT NULL,
	"issued_by" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_enrollment_budgets" (
	"key" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"used" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"profiles" text[] NOT NULL,
	"environments" jsonb NOT NULL,
	"enrollment_hash" text,
	"enrollment_expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"credential_generation" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"budget_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"budget_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workers_enrollment_hash_unique" UNIQUE("enrollment_hash"),
	CONSTRAINT "workers_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "worker_audit_events" ADD CONSTRAINT "worker_audit_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_audit_events_worker_occurred_idx" ON "worker_audit_events" USING btree ("worker_id","occurred_at");