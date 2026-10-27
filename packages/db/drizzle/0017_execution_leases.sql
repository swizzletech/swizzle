CREATE TABLE "execution_leases" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"check_id" uuid,
	"due_at" timestamp with time zone,
	"worker_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"segment_attempt" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released" boolean DEFAULT false NOT NULL,
	"result_digest" text,
	"deadline_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_leases_one_target" CHECK (("execution_leases"."run_id" is not null and "execution_leases"."check_id" is null and "execution_leases"."due_at" is null) or ("execution_leases"."run_id" is null and "execution_leases"."check_id" is not null and "execution_leases"."due_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "placement_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "local" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "draining" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_leases" ADD CONSTRAINT "execution_leases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_leases" ADD CONSTRAINT "execution_leases_check_id_automation_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."automation_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_leases" ADD CONSTRAINT "execution_leases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_leases_worker_expiry_idx" ON "execution_leases" USING btree ("worker_id","expires_at");